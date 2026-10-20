from fastapi import APIRouter, Depends, Query

from app.api.deps import Ctx, get_ctx
from app.core.config import get_settings
from app.errors import AppError
from app.models import (
    Campaign,
    CampaignRecipient,
    Contact,
    EmailTemplate,
    Message,
    MessageRecipient,
    utcnow,
)
from app.schemas import CampaignIn, CampaignLaunchIn, CampaignRecipientsIn
from app.services.events import audit, record_event
from app.services.messaging import is_suppressed, normalize_address, queue_message, upsert_contact
from app.services.personalize import find_variables
from app.services.signals import iso

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


def _owned(ctx: Ctx, campaign_id: str) -> Campaign:
    row = (
        ctx.db.query(Campaign)
        .filter(Campaign.id == campaign_id, Campaign.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if row is None:
        raise AppError(404, "not_found", "That campaign is not in this workspace.")
    return row


def _counts(ctx: Ctx, campaign_id: str) -> dict:
    rows = ctx.db.query(CampaignRecipient).filter(CampaignRecipient.campaign_id == campaign_id).all()
    return {
        "total": len(rows),
        "pending": sum(1 for item in rows if item.status == "pending"),
        "skipped": sum(1 for item in rows if item.status == "skipped"),
        "queued": sum(1 for item in rows if item.status == "queued"),
        "sent": sum(1 for item in rows if item.status == "sent"),
        "failed": sum(1 for item in rows if item.status == "failed"),
    }


def _payload(ctx: Ctx, row: Campaign) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "subject": row.subject,
        "body_text": row.body_text,
        "body_html": row.body_html,
        "status": row.status,
        "template_id": row.template_id,
        "message_id": row.message_id,
        "open_tracking": row.open_tracking,
        "link_tracking": row.link_tracking,
        "gmail_connection_id": row.gmail_connection_id,
        "document_id": row.document_id,
        "attach_pdf": row.attach_pdf,
        "include_sheet_link": row.include_sheet_link,
        "error_message": row.error_message,
        "launched_at": iso(row.launched_at),
        "completed_at": iso(row.completed_at),
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
        "counts": _counts(ctx, row.id),
        "variables": sorted(find_variables(f"{row.subject}\n{row.body_text}\n{row.body_html or ''}")),
    }


@router.get("")
def list_campaigns(ctx: Ctx = Depends(get_ctx), limit: int = Query(50, ge=1, le=100)):
    rows = (
        ctx.db.query(Campaign)
        .filter(Campaign.workspace_id == ctx.workspace.id)
        .order_by(Campaign.created_at.desc())
        .limit(limit)
        .all()
    )
    return {"campaigns": [_payload(ctx, row) for row in rows]}


@router.post("")
def create_campaign(payload: CampaignIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    subject = payload.subject.strip()
    body_text = payload.body_text
    body_html = payload.body_html
    template_id = payload.template_id
    if template_id:
        template = (
            ctx.db.query(EmailTemplate)
            .filter(EmailTemplate.id == template_id, EmailTemplate.workspace_id == ctx.workspace.id)
            .one_or_none()
        )
        if template is None:
            raise AppError(404, "not_found", "That template is not in this workspace.")
        subject = subject or template.subject
        body_text = body_text or template.body_text
        body_html = body_html if body_html is not None else template.body_html
    row = Campaign(
        workspace_id=ctx.workspace.id,
        created_by=ctx.user.id,
        name=payload.name.strip(),
        subject=subject,
        body_text=body_text,
        body_html=body_html,
        status="draft",
        template_id=template_id,
        open_tracking=(
            ctx.workspace.open_tracking_default
            if payload.tracking.open_pixel is None
            else payload.tracking.open_pixel
        ),
        link_tracking=(
            ctx.workspace.link_tracking_default
            if payload.tracking.link_clicks is None
            else payload.tracking.link_clicks
        ),
        gmail_connection_id=payload.gmail_connection_id,
        document_id=payload.document_id,
        attach_pdf=payload.attach_pdf,
        include_sheet_link=payload.include_sheet_link,
    )
    ctx.db.add(row)
    ctx.db.flush()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="campaign_created",
        target_type="campaign",
        target_id=row.id,
        details={"name": row.name},
    )
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(ctx, row)


@router.get("/{campaign_id}")
def get_campaign(campaign_id: str, ctx: Ctx = Depends(get_ctx)):
    row = _owned(ctx, campaign_id)
    recipients = (
        ctx.db.query(CampaignRecipient)
        .filter(CampaignRecipient.campaign_id == row.id)
        .order_by(CampaignRecipient.created_at.asc())
        .limit(200)
        .all()
    )
    return {
        **_payload(ctx, row),
        "recipients": [
            {
                "id": item.id,
                "email": item.email,
                "name": item.display_name,
                "status": item.status,
                "skip_reason": item.skip_reason,
                "custom_fields": item.custom_fields or {},
            }
            for item in recipients
        ],
    }


@router.post("/{campaign_id}/recipients")
def set_recipients(campaign_id: str, payload: CampaignRecipientsIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = _owned(ctx, campaign_id)
    if row.status not in {"draft", "paused"}:
        raise AppError(400, "immutable", "Recipients can only be edited while the campaign is draft or paused.")
    if len(payload.recipients) > get_settings().max_recipients:
        raise AppError(
            400,
            "too_many_recipients",
            f"Campaigns support {get_settings().max_recipients} recipients or fewer in this release.",
        )
    ctx.db.query(CampaignRecipient).filter(CampaignRecipient.campaign_id == row.id).delete(synchronize_session=False)
    seen = set()
    created = []
    skipped = []
    for item in payload.recipients:
        email, name = normalize_address(item.email, item.name)
        if email in seen:
            skipped.append({"email": email, "reason": "duplicate"})
            continue
        seen.add(email)
        custom = dict(item.custom_fields or {})
        contact = upsert_contact(
            ctx.db,
            ctx.workspace.id,
            email,
            name,
            custom_fields=custom,
            source="campaign",
        )
        status = "pending"
        reason = None
        if is_suppressed(ctx.db, ctx.workspace.id, email):
            status = "skipped"
            reason = "suppressed"
            skipped.append({"email": email, "reason": "suppressed"})
        recipient = CampaignRecipient(
            workspace_id=ctx.workspace.id,
            campaign_id=row.id,
            contact_id=contact.id,
            email=email,
            display_name=name,
            custom_fields=custom,
            status=status,
            skip_reason=reason,
        )
        ctx.db.add(recipient)
        created.append(recipient)
    if payload.contact_ids:
        for contact_id in payload.contact_ids:
            contact = (
                ctx.db.query(Contact)
                .filter(Contact.id == contact_id, Contact.workspace_id == ctx.workspace.id)
                .one_or_none()
            )
            if contact is None or contact.email in seen:
                continue
            seen.add(contact.email)
            status = "pending"
            reason = None
            if is_suppressed(ctx.db, ctx.workspace.id, contact.email):
                status = "skipped"
                reason = "suppressed"
            ctx.db.add(
                CampaignRecipient(
                    workspace_id=ctx.workspace.id,
                    campaign_id=row.id,
                    contact_id=contact.id,
                    email=contact.email,
                    display_name=contact.display_name,
                    custom_fields=contact.custom_fields or {},
                    status=status,
                    skip_reason=reason,
                )
            )
    ctx.db.commit()
    return {**_payload(ctx, row), "import_skipped": skipped}


@router.post("/{campaign_id}/launch")
def launch_campaign(campaign_id: str, payload: CampaignLaunchIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = _owned(ctx, campaign_id)
    if row.status not in {"draft", "paused"}:
        raise AppError(400, "invalid_status", "Only draft or paused campaigns can be launched.")
    if not row.subject.strip():
        raise AppError(400, "subject_required", "Add a subject before launching.")
    if not (row.body_text.strip() or (row.body_html or "").strip()):
        raise AppError(400, "empty_message", "Write a message before launching.")
    pending = (
        ctx.db.query(CampaignRecipient)
        .filter(CampaignRecipient.campaign_id == row.id, CampaignRecipient.status == "pending")
        .all()
    )
    if not pending:
        raise AppError(400, "recipients_required", "Add at least one eligible recipient before launching.")
    if payload.confirm_count is not None and payload.confirm_count != len(pending):
        raise AppError(
            400,
            "confirm_count_mismatch",
            f"Confirm launch for {len(pending)} recipients. Refresh the campaign and try again.",
        )

    message = Message(
        workspace_id=ctx.workspace.id,
        created_by=ctx.user.id,
        subject=row.subject,
        body_text=row.body_text,
        body_html=row.body_html,
        body_format="html" if row.body_html else "plain",
        open_tracking=row.open_tracking,
        link_tracking=row.link_tracking,
        gmail_connection_id=row.gmail_connection_id or payload.gmail_connection_id,
        document_id=row.document_id,
        attach_pdf=row.attach_pdf,
        include_sheet_link=row.include_sheet_link,
        campaign_id=row.id,
        template_id=row.template_id,
        send_status="draft",
    )
    ctx.db.add(message)
    ctx.db.flush()
    for item in pending:
        ctx.db.add(
            MessageRecipient(
                workspace_id=ctx.workspace.id,
                message_id=message.id,
                contact_id=item.contact_id,
                email_snapshot=item.email,
                display_name_snapshot=item.display_name,
                recipient_type="to",
                send_status="draft",
            )
        )
        item.status = "queued"
    row.message_id = message.id
    row.status = "queued"
    row.launched_at = utcnow()
    row.error_message = None
    ctx.db.flush()
    queue_message(ctx.db, message, ctx.user, document_expires_days=30)
    row.status = "sending"
    for item in pending:
        if item.status == "queued":
            item.status = "sending"
    record_event(
        ctx.db,
        workspace_id=ctx.workspace.id,
        message_id=message.id,
        event_type="campaign_launched",
        source="system",
        details={"campaign_id": row.id, "recipient_count": len(pending), "counts_toward_metric": 0},
    )
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="campaign_launched",
        target_type="campaign",
        target_id=row.id,
        details={"message_id": message.id, "recipient_count": len(pending)},
    )
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(ctx, row)


@router.post("/{campaign_id}/cancel")
def cancel_campaign(campaign_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = _owned(ctx, campaign_id)
    if row.status not in {"queued", "sending", "paused", "draft"}:
        raise AppError(400, "invalid_status", "This campaign cannot be cancelled.")
    if row.message_id:
        recipients = (
            ctx.db.query(MessageRecipient)
            .filter(
                MessageRecipient.message_id == row.message_id,
                MessageRecipient.send_status.in_(["queued", "draft"]),
            )
            .all()
        )
        for recipient in recipients:
            recipient.send_status = "cancelled"
            recipient.error_code = "cancelled"
            recipient.error_message = "Campaign cancelled before send."
        message = ctx.db.get(Message, row.message_id)
        if message and message.send_status in {"queued", "sending", "draft"}:
            message.send_status = "cancelled"
    for item in ctx.db.query(CampaignRecipient).filter(
        CampaignRecipient.campaign_id == row.id,
        CampaignRecipient.status.in_(["pending", "queued", "sending"]),
    ):
        item.status = "cancelled"
        item.skip_reason = "cancelled"
    row.status = "cancelled"
    row.completed_at = utcnow()
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(ctx, row)


