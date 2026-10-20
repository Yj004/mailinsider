from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, func

from app.api.deps import Ctx, get_ctx
from app.errors import AppError
from app.models import CampaignRecipient, Contact, Message, MessageRecipient, TrackingEvent, as_utc, utcnow
from app.schemas import ContactBulkDeleteIn, ContactCreateIn, ContactPatchIn
from app.services.messaging import normalize_address
from app.services.signals import automated, counts, iso, public_details, recipient_signal

router = APIRouter(prefix="/contacts", tags=["contacts"])


def _payload(row: Contact) -> dict:
    return {
        "id": row.id,
        "email": row.email,
        "name": row.display_name,
        "display_name": row.display_name,
        "company": row.company,
        "job_title": row.job_title,
        "linkedin_url": row.linkedin_url,
        "company_website": row.company_website,
        "job_posting_url": row.job_posting_url,
        "target_role": row.target_role,
        "pipeline_status": row.pipeline_status or "to_contact",
        "notes": row.notes,
        "tags": row.tags or [],
        "last_contacted_at": iso(row.last_contacted_at),
        "next_follow_up_at": iso(row.next_follow_up_at),
        "custom_fields": row.custom_fields or {},
        "source": row.source,
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
        "follow_up_overdue": bool(
            row.next_follow_up_at and as_utc(row.next_follow_up_at) and as_utc(row.next_follow_up_at) <= utcnow()
        ),
    }


def _owned(ctx: Ctx, contact_id: str) -> Contact:
    row = (
        ctx.db.query(Contact)
        .filter(Contact.id == contact_id, Contact.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if row is None:
        raise AppError(404, "not_found", "That contact is not in this workspace.")
    return row


@router.get("")
def list_contacts(
    ctx: Ctx = Depends(get_ctx),
    q: str = "",
    status: str = "",
    follow_ups: str = "",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    query = ctx.db.query(Contact).filter(Contact.workspace_id == ctx.workspace.id)
    if q.strip():
        like = f"%{q.strip().lower()}%"
        query = query.filter(
            or_(
                func.lower(Contact.email).like(like),
                func.lower(Contact.display_name).like(like),
                func.lower(Contact.company).like(like),
                func.lower(Contact.target_role).like(like),
            )
        )
    if status:
        query = query.filter(Contact.pipeline_status == status)
    if follow_ups == "due":
        query = query.filter(Contact.next_follow_up_at.isnot(None), Contact.next_follow_up_at <= utcnow())
    elif follow_ups == "upcoming":
        query = query.filter(Contact.next_follow_up_at.isnot(None), Contact.next_follow_up_at > utcnow())
    total = query.count()
    if follow_ups:
        rows = query.order_by(Contact.next_follow_up_at.asc(), Contact.updated_at.desc()).offset(offset).limit(limit).all()
    else:
        rows = query.order_by(Contact.updated_at.desc()).offset(offset).limit(limit).all()
    return {"contacts": [_payload(row) for row in rows], "total": total, "limit": limit, "offset": offset}


@router.post("")
def create_contact(payload: ContactCreateIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    email, name = normalize_address(payload.email, payload.display_name)
    existing = (
        ctx.db.query(Contact)
        .filter(Contact.workspace_id == ctx.workspace.id, Contact.email == email)
        .one_or_none()
    )
    if existing:
        raise AppError(409, "duplicate_contact", "That email is already in this workspace.")
    row = Contact(
        workspace_id=ctx.workspace.id,
        email=email,
        display_name=name or payload.display_name,
        company=payload.company,
        job_title=payload.job_title,
        linkedin_url=payload.linkedin_url,
        company_website=payload.company_website,
        job_posting_url=payload.job_posting_url,
        target_role=payload.target_role,
        pipeline_status=payload.pipeline_status,
        notes=payload.notes,
        tags=payload.tags,
        next_follow_up_at=payload.next_follow_up_at,
        custom_fields=payload.custom_fields,
        source="manual",
    )
    ctx.db.add(row)
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(row)


@router.get("/follow-ups")
def follow_up_queue(ctx: Ctx = Depends(get_ctx), limit: int = Query(50, ge=1, le=200)):
    from app.models import Message
    from app.services.messaging import FOLLOW_UP_CADENCE_DAYS
    from app.services.signals import iso

    due = (
        ctx.db.query(Contact)
        .filter(
            Contact.workspace_id == ctx.workspace.id,
            Contact.next_follow_up_at.isnot(None),
            Contact.next_follow_up_at <= utcnow(),
            Contact.pipeline_status.notin_(["closed", "rejected", "no_response"]),
        )
        .order_by(Contact.next_follow_up_at.asc())
        .limit(limit)
        .all()
    )
    upcoming = (
        ctx.db.query(Contact)
        .filter(
            Contact.workspace_id == ctx.workspace.id,
            Contact.next_follow_up_at.isnot(None),
            Contact.next_follow_up_at > utcnow(),
            Contact.pipeline_status.notin_(["closed", "rejected", "no_response"]),
        )
        .order_by(Contact.next_follow_up_at.asc())
        .limit(limit)
        .all()
    )
    message_due = (
        ctx.db.query(Message)
        .filter(
            Message.workspace_id == ctx.workspace.id,
            Message.parent_message_id.is_(None),
            Message.send_status.in_(["sent", "partial"]),
            Message.next_follow_up_at.isnot(None),
            Message.next_follow_up_at <= utcnow(),
            Message.conversation_status.notin_(["ended", "dead"]),
        )
        .order_by(Message.next_follow_up_at.asc())
        .limit(limit)
        .all()
    )
    message_upcoming = (
        ctx.db.query(Message)
        .filter(
            Message.workspace_id == ctx.workspace.id,
            Message.parent_message_id.is_(None),
            Message.send_status.in_(["sent", "partial"]),
            Message.next_follow_up_at.isnot(None),
            Message.next_follow_up_at > utcnow(),
            Message.conversation_status.notin_(["ended", "dead"]),
        )
        .order_by(Message.next_follow_up_at.asc())
        .limit(limit)
        .all()
    )
    dead = (
        ctx.db.query(Message)
        .filter(
            Message.workspace_id == ctx.workspace.id,
            Message.parent_message_id.is_(None),
            Message.conversation_status == "dead",
        )
        .order_by(Message.updated_at.desc())
        .limit(limit)
        .all()
    )

    def _thread(row: Message) -> dict:
        return {
            "id": row.id,
            "subject": row.subject,
            "follow_up_count": int(row.follow_up_count or 0),
            "next_follow_up_at": iso(row.next_follow_up_at),
            "conversation_status": row.conversation_status or "active",
            "sent_at": iso(row.sent_at),
        }

    return {
        "due": [_payload(row) for row in due],
        "upcoming": [_payload(row) for row in upcoming],
        "due_count": len(due),
        "threads_due": [_thread(row) for row in message_due],
        "threads_upcoming": [_thread(row) for row in message_upcoming],
        "threads_dead": [_thread(row) for row in dead],
        "threads_due_count": len(message_due),
        "definitions": {
            "due": "Contacts whose next follow-up time is now or earlier.",
            "cadence": f"After each send, the next follow-up is scheduled in {FOLLOW_UP_CADENCE_DAYS} days until you mark a reply.",
            "reply_detection": "Gmail reply sync is not enabled. When someone replies, open the thread and choose Continue (3 days), Wait 7 days, End, or Dead mail.",
        },
    }


@router.get("/{contact_id}")
def get_contact(contact_id: str, ctx: Ctx = Depends(get_ctx)):
    row = _owned(ctx, contact_id)
    recipients = (
        ctx.db.query(MessageRecipient)
        .filter(MessageRecipient.contact_id == row.id, MessageRecipient.workspace_id == ctx.workspace.id)
        .order_by(MessageRecipient.created_at.desc())
        .limit(40)
        .all()
    )
    message_ids = [item.message_id for item in recipients]
    messages = (
        {item.id: item for item in ctx.db.query(Message).filter(Message.id.in_(message_ids)).all()} if message_ids else {}
    )
    events = (
        ctx.db.query(TrackingEvent)
        .filter(TrackingEvent.message_recipient_id.in_([item.id for item in recipients]))
        .order_by(TrackingEvent.occurred_at.desc())
        .limit(100)
        .all()
        if recipients
        else []
    )
    return {
        "contact": _payload(row),
        "messages": [
            {
                "id": messages[item.message_id].id,
                "subject": messages[item.message_id].subject,
                "send_status": messages[item.message_id].send_status,
                "sent_at": iso(messages[item.message_id].sent_at),
                "signal": recipient_signal(events, item.id),
            }
            for item in recipients
            if item.message_id in messages
        ],
        "events": [
            {
                "id": event.id,
                "event_type": event.event_type,
                "source": event.source,
                "occurred_at": iso(event.occurred_at),
                "message_id": event.message_id,
                "possible_automated": automated(event),
                "counts_toward_metric": counts(event),
                "metadata": public_details(event.details),
            }
            for event in events
        ],
    }


@router.patch("/{contact_id}")
def patch_contact(contact_id: str, payload: ContactPatchIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = _owned(ctx, contact_id)
    data = payload.model_dump(exclude_unset=True)
    clear = data.pop("clear_follow_up", False)
    for key, value in data.items():
        setattr(row, key, value)
    if clear:
        row.next_follow_up_at = None
    row.updated_at = utcnow()
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(row)


def _detach_contact_refs(ctx: Ctx, contact_ids: list[str]) -> None:
    """Keep send history; drop the CRM link so contacts can be removed safely."""
    if not contact_ids:
        return
    (
        ctx.db.query(MessageRecipient)
        .filter(
            MessageRecipient.workspace_id == ctx.workspace.id,
            MessageRecipient.contact_id.in_(contact_ids),
        )
        .update({MessageRecipient.contact_id: None}, synchronize_session=False)
    )
    (
        ctx.db.query(CampaignRecipient)
        .filter(
            CampaignRecipient.workspace_id == ctx.workspace.id,
            CampaignRecipient.contact_id.in_(contact_ids),
        )
        .update({CampaignRecipient.contact_id: None}, synchronize_session=False)
    )


@router.post("/bulk-delete")
def bulk_delete_contacts(payload: ContactBulkDeleteIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    ids = list(dict.fromkeys(item.strip() for item in payload.contact_ids if item and item.strip()))
    if not ids:
        raise AppError(400, "empty", "Select at least one contact to delete.")
    if len(ids) > 200:
        raise AppError(400, "too_many", "Delete 200 contacts or fewer at a time.")
    rows = (
        ctx.db.query(Contact)
        .filter(Contact.workspace_id == ctx.workspace.id, Contact.id.in_(ids))
        .all()
    )
    found_ids = [row.id for row in rows]
    _detach_contact_refs(ctx, found_ids)
    for row in rows:
        ctx.db.delete(row)
    ctx.db.commit()
    return {"deleted": len(found_ids), "requested": len(ids)}


@router.delete("/{contact_id}")
def delete_contact(contact_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = _owned(ctx, contact_id)
    _detach_contact_refs(ctx, [row.id])
    ctx.db.delete(row)
    ctx.db.commit()
    return {"deleted": True}
