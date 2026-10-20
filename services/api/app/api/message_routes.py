from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import exists, func, or_
from sqlalchemy.orm import Session

from app.api.deps import Ctx, get_ctx
from app.core.config import get_settings
from app.errors import AppError
from app.models import (
    Contact,
    DocumentAccessToken,
    DocumentAsset,
    GmailConnection,
    Message,
    MessageRecipient,
    MessageReply,
    OpenToken,
    SheetLog,
    TrackingEvent,
    TrackingLink,
    UnsubscribeToken,
    as_utc,
    utcnow,
)
from app.schemas import ConversationActionIn, MessageIn, RetryIn
from app.services.messaging import (
    FOLLOW_UP_CADENCE_DAYS,
    queue_message,
    reply_payload,
    retry_message,
    revoke_tracking,
    root_message,
    sends_today,
    sync_thread_replies,
    sync_workspace_replies,
    upsert_contact,
    normalize_address,
)
from app.services.signals import ENGAGEMENT_TYPES, automated, counts, iso, public_details, recipient_signal

router = APIRouter(tags=["messages"])


def _check_workspace(payload_workspace_id: str | None, ctx: Ctx) -> None:
    if payload_workspace_id and payload_workspace_id != ctx.workspace.id:
        raise AppError(403, "forbidden", "You do not belong to that workspace.")


def _events_for(db: Session, message_ids: list[str]) -> list[TrackingEvent]:
    if not message_ids:
        return []
    return (
        db.query(TrackingEvent)
        .filter(TrackingEvent.message_id.in_(message_ids))
        .order_by(TrackingEvent.occurred_at.asc())
        .all()
    )


def _demo_map(db: Session, messages: list[Message]) -> dict[str, bool]:
    ids = {item.gmail_connection_id for item in messages if item.gmail_connection_id}
    if not ids:
        return {}
    rows = db.query(GmailConnection).filter(GmailConnection.id.in_(ids)).all()
    return {row.id: row.is_demo for row in rows}


def _recipient_payload(recipient: MessageRecipient, events: list[TrackingEvent]) -> dict:
    mine = [event for event in events if event.message_recipient_id == recipient.id]
    return {
        "id": recipient.id,
        "email": recipient.email_snapshot,
        "name": recipient.display_name_snapshot,
        "type": recipient.recipient_type,
        "send_status": recipient.send_status,
        "gmail_message_id": recipient.gmail_message_id,
        "error_code": recipient.error_code,
        "error_message": recipient.error_message,
        "signal": recipient_signal(events, recipient.id),
        "open_count": sum(
            1 for event in mine if event.event_type == "open_pixel_requested" and counts(event)
        ),
        "click_count": sum(
            1 for event in mine if event.event_type == "tracked_link_requested" and counts(event)
        ),
        "document_views": sum(1 for event in mine if event.event_type == "document_view_started" and counts(event)),
        "possible_automated": any(automated(event) for event in mine),
    }


def _engagement(recipient_ids: set[str], events: list[TrackingEvent]) -> dict:
    def unique(event_type: str) -> int:
        return len(
            {
                event.message_recipient_id
                for event in events
                if event.message_recipient_id in recipient_ids
                and event.event_type == event_type
                and counts(event)
            }
        )

    return {
        "estimated_opens": unique("open_pixel_requested"),
        "link_clicks": unique("tracked_link_requested"),
        "document_views": unique("document_view_started"),
    }


def _summary(message: Message, recipients: list[MessageRecipient], events: list[TrackingEvent], demo: bool) -> dict:
    signals = {"open_detected": 0, "link_clicked": 0, "document_viewed": 0, "possible_automated": 0, "no_activity": 0}
    preview = []
    for recipient in recipients:
        if recipient.recipient_type != "to":
            continue
        signal = recipient_signal(events, recipient.id)
        bucket = {
            "open_detected": "open_detected",
            "link_clicked": "link_clicked",
            "document_viewed": "document_viewed",
            "possible_automated": "possible_automated",
            "no_activity": "no_activity",
        }[signal]
        signals[bucket] += 1
        preview.append(
            {
                "email": recipient.email_snapshot,
                "name": recipient.display_name_snapshot,
                "signal": signal,
            }
        )
    preview_ids = {recipient.id for recipient in recipients if recipient.recipient_type == "to"}
    next_due = message.next_follow_up_at
    follow_count = int(message.follow_up_count or 0)
    status = message.conversation_status or "active"
    overdue = bool(next_due and as_utc(next_due) and as_utc(next_due) <= utcnow() and status not in {"ended", "dead"})
    return {
        "id": message.id,
        "subject": message.subject,
        "send_status": message.send_status,
        "is_sample": message.is_sample,
        "demo": demo,
        "from_email": message.from_email,
        "created_at": iso(message.created_at),
        "sent_at": iso(message.sent_at),
        "error_code": message.error_code,
        "error_message": message.error_message,
        "recipient_count": len(preview),
        "recipients_preview": preview[:4],
        "signals": signals,
        "preview": " ".join((message.body_text or "").split())[:140],
        "engagement": _engagement(preview_ids, events),
        "parent_message_id": message.parent_message_id,
        "follow_up_count": follow_count,
        "follow_up_index": int(message.follow_up_index or 0),
        "next_follow_up_at": iso(next_due),
        "conversation_status": status,
        "follow_up_overdue": overdue,
        "follow_up_cadence_days": FOLLOW_UP_CADENCE_DAYS,
    }


def _replace_recipients(ctx: Ctx, message: Message, payload: MessageIn) -> list[MessageRecipient]:
    groups = [("to", payload.to), ("cc", payload.cc), ("bcc", payload.bcc)]
    flat = [(kind, item) for kind, items in groups for item in items]
    if len(flat) > get_settings().max_recipients:
        raise AppError(
            400,
            "too_many_recipients",
            f"Send to {get_settings().max_recipients} recipients or fewer at a time.",
        )
    seen = set()
    ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id == message.id).delete(synchronize_session=False)
    created = []
    for kind, item in flat:
        email, name = normalize_address(item.email, item.name)
        key = (kind, email)
        if key in seen:
            continue
        seen.add(key)
        contact = upsert_contact(ctx.db, ctx.workspace.id, email, name)
        recipient = MessageRecipient(
            workspace_id=ctx.workspace.id,
            message_id=message.id,
            contact_id=contact.id,
            email_snapshot=email,
            display_name_snapshot=name,
            recipient_type=kind,
            send_status="draft",
        )
        ctx.db.add(recipient)
        created.append(recipient)
    return created


def _apply_content(ctx: Ctx, message: Message, payload: MessageIn) -> None:
    if payload.send and not payload.subject.strip():
        raise AppError(400, "subject_required", "Add a subject before sending.")
    if payload.send and not (payload.body_text.strip() or (payload.body_html or "").strip() or payload.document_id):
        raise AppError(400, "empty_message", "Write a message or attach a document before sending.")
    if payload.body_html and len(payload.body_html) > 100_000:
        raise AppError(400, "invalid_request", "Message body is too long.")
    message.subject = payload.subject.strip() or "(no subject)"
    message.body_text = payload.body_text
    message.body_html = payload.body_html
    message.body_format = "html" if payload.body_html else "plain"
    message.open_tracking = (
        ctx.workspace.open_tracking_default if payload.tracking.open_pixel is None else payload.tracking.open_pixel
    )
    message.link_tracking = (
        ctx.workspace.link_tracking_default if payload.tracking.link_clicks is None else payload.tracking.link_clicks
    )
    message.gmail_connection_id = payload.gmail_connection_id
    message.document_id = payload.document_id
    message.attach_pdf = payload.attach_pdf
    message.include_sheet_link = payload.include_sheet_link
    if payload.document_id:
        document = (
            ctx.db.query(DocumentAsset)
            .filter(DocumentAsset.id == payload.document_id, DocumentAsset.workspace_id == ctx.workspace.id)
            .one_or_none()
        )
        if document is None:
            raise AppError(404, "not_found", "That document is not in this workspace.")
    if payload.document_expires_days is not None and not 1 <= payload.document_expires_days <= 365:
        raise AppError(400, "invalid_request", "Document link expiry must be between 1 and 365 days.")


@router.post("/messages")
def create_message(payload: MessageIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    _check_workspace(payload.workspace_id, ctx)
    if payload.idempotency_key:
        existing = (
            ctx.db.query(Message)
            .filter(Message.workspace_id == ctx.workspace.id, Message.idempotency_key == payload.idempotency_key)
            .one_or_none()
        )
        if existing:
            return get_message(existing.id, ctx)
    if payload.send:
        upcoming = len(payload.to) or 1
        if sends_today(ctx.db, ctx.workspace.id) + upcoming > get_settings().daily_send_limit:
            raise AppError(
                429,
                "quota",
                f"This workspace has reached {get_settings().daily_send_limit} recipient sends today. Gmail limits still apply on top of this.",
            )
    message = Message(
        workspace_id=ctx.workspace.id,
        created_by=ctx.user.id,
        subject=payload.subject.strip() or "(no subject)",
        send_status="draft",
        idempotency_key=payload.idempotency_key,
        is_sample=False,
    )
    ctx.db.add(message)
    ctx.db.flush()
    _apply_content(ctx, message, payload)
    _apply_parent(ctx, message, payload.parent_message_id)
    created = _replace_recipients(ctx, message, payload)
    ctx.db.flush()
    if payload.send and not any(item.recipient_type == "to" for item in created):
        raise AppError(400, "recipients_required", "Add at least one To recipient.")
    ctx.db.commit()
    if payload.send:
        message = queue_message(ctx.db, message, ctx.user, payload.document_expires_days)
    return get_message(message.id, ctx)


def _apply_parent(ctx: Ctx, message: Message, parent_id: str | None) -> None:
    if not parent_id:
        return
    parent = _owned(ctx, parent_id)
    root = root_message(ctx.db, parent)
    if (root.conversation_status or "active") in {"ended", "dead"}:
        raise AppError(400, "conversation_closed", "This conversation is ended or marked dead. Start a new thread instead.")
    message.parent_message_id = root.id
    message.follow_up_index = int(root.follow_up_count or 0) + 1
    # Stay in the same Gmail thread: same mailbox + same subject family as the root.
    if root.gmail_connection_id:
        message.gmail_connection_id = root.gmail_connection_id
        if root.from_email:
            message.from_email = root.from_email
    base = (root.subject or "").strip() or "(no subject)"
    message.subject = base if base.lower().startswith("re:") else f"Re: {base}"


@router.get("/messages")
def list_messages(
    ctx: Ctx = Depends(get_ctx),
    q: str = "",
    status: str = "",
    attention: bool = False,
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
    sort: str = "created_at",
    order: str = "desc",
    start: str | None = Query(default=None, alias="from"),
    end: str | None = Query(default=None, alias="to"),
):
    query = ctx.db.query(Message).filter(Message.workspace_id == ctx.workspace.id)
    if status:
        query = query.filter(Message.send_status == status)
    if attention:
        engaged = exists().where(
            TrackingEvent.message_id == Message.id,
            TrackingEvent.event_type.in_(ENGAGEMENT_TYPES),
        )
        query = query.filter(Message.send_status == "sent", ~engaged)
    if q.strip():
        like = f"%{q.strip().lower()}%"
        recipient_ids = ctx.db.query(MessageRecipient.message_id).filter(
            MessageRecipient.workspace_id == ctx.workspace.id,
            func.lower(MessageRecipient.email_snapshot).like(like),
        )
        query = query.filter(or_(func.lower(Message.subject).like(like), Message.id.in_(recipient_ids)))
    if start or end:
        begin, finish = _parse_range(start, end)
        stamp = func.coalesce(Message.sent_at, Message.created_at)
        query = query.filter(stamp >= begin, stamp < finish)
    total = query.count()
    columns = {
        "created_at": Message.created_at,
        "sent_at": Message.sent_at,
        "subject": Message.subject,
        "status": Message.send_status,
    }
    column = columns.get(sort, Message.created_at)
    direction = column.asc() if order == "asc" else column.desc()
    rows = query.order_by(direction, Message.created_at.desc()).offset(offset).limit(limit).all()
    ids = [row.id for row in rows]
    recipients = (
        ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id.in_(ids)).all() if ids else []
    )
    events = _events_for(ctx.db, ids)
    demos = _demo_map(ctx.db, rows)
    items = []
    for message in rows:
        mine = [item for item in recipients if item.message_id == message.id]
        items.append(_summary(message, mine, [event for event in events if event.message_id == message.id], demos.get(message.gmail_connection_id or "", False)))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/messages/{message_id}")
def get_message(message_id: str, ctx: Ctx = Depends(get_ctx)):
    message = _owned(ctx, message_id)
    recipients = (
        ctx.db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == message.id)
        .order_by(MessageRecipient.created_at.asc())
        .all()
    )
    events = _events_for(ctx.db, [message.id])
    demos = _demo_map(ctx.db, [message])
    document = None
    if message.document_id:
        asset = ctx.db.get(DocumentAsset, message.document_id)
        if asset and asset.workspace_id == ctx.workspace.id:
            document = {"id": asset.id, "filename": asset.filename}
    summary = _summary(message, recipients, events, demos.get(message.gmail_connection_id or "", False))
    root = root_message(ctx.db, message)
    replies = (
        ctx.db.query(MessageReply)
        .filter(MessageReply.message_id == root.id)
        .order_by(MessageReply.occurred_at.asc().nullslast(), MessageReply.created_at.asc())
        .all()
    )
    followups = (
        ctx.db.query(Message)
        .filter(Message.parent_message_id == root.id, Message.workspace_id == ctx.workspace.id)
        .order_by(Message.sent_at.asc().nullslast(), Message.created_at.asc())
        .all()
    )
    root_recipients = (
        recipients
        if root.id == message.id
        else ctx.db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == root.id)
        .order_by(MessageRecipient.created_at.asc())
        .all()
    )
    conversation = _conversation_thread(root, message, root_recipients, replies, followups)
    summary.update(
        {
            "body_text": message.body_text,
            "body_html": message.body_html,
            "open_tracking": message.open_tracking,
            "link_tracking": message.link_tracking,
            "attach_pdf": message.attach_pdf,
            "include_sheet_link": message.include_sheet_link,
            "document": document,
            "recipients": [_recipient_payload(item, events) for item in recipients],
            "multi_to_note": len([item for item in recipients if item.recipient_type == "to"]) > 1,
            "thread_root_id": root.id,
            "gmail_connection_id": root.gmail_connection_id,
            "gmail_thread_id": root.gmail_thread_id,
            "follow_up_count": int(root.follow_up_count or 0),
            "next_follow_up_at": iso(root.next_follow_up_at),
            "conversation_status": root.conversation_status or "active",
            "follow_up_overdue": bool(
                root.next_follow_up_at
                and as_utc(root.next_follow_up_at)
                and as_utc(root.next_follow_up_at) <= utcnow()
                and (root.conversation_status or "active") not in {"ended", "dead"}
            ),
            "follow_up_cadence_days": FOLLOW_UP_CADENCE_DAYS,
            "replies": [reply_payload(row) for row in replies],
            "reply_count": len(replies),
            "conversation": conversation,
        }
    )
    return summary


def _conversation_thread(
    root: Message,
    current: Message,
    recipients: list[MessageRecipient],
    replies: list[MessageReply],
    followups: list[Message],
) -> list[dict]:
    """Gmail-style chronological conversation for the thread root."""
    to_list = [item for item in recipients if item.recipient_type == "to"]
    to_label = ", ".join((item.display_name_snapshot or item.email_snapshot) for item in to_list) or "recipient"
    items: list[dict] = [
        {
            "id": root.id,
            "kind": "outbound",
            "message_id": root.id,
            "from_name": "You",
            "from_email": root.from_email,
            "to_label": to_label,
            "subject": root.subject,
            "snippet": " ".join((root.body_text or "").split())[:160],
            "body_text": root.body_text,
            "body_html": root.body_html,
            "occurred_at": iso(root.sent_at or root.created_at),
            "follow_up_index": 0,
        }
    ]
    for follow in followups:
        items.append(
            {
                "id": follow.id,
                "kind": "outbound",
                "message_id": follow.id,
                "from_name": "You",
                "from_email": follow.from_email,
                "to_label": to_label,
                "subject": follow.subject,
                "snippet": " ".join((follow.body_text or "").split())[:160],
                "body_text": follow.body_text,
                "body_html": follow.body_html,
                "occurred_at": iso(follow.sent_at or follow.created_at),
                "follow_up_index": int(follow.follow_up_index or 0),
            }
        )
    for reply in replies:
        items.append(
            {
                "id": reply.id,
                "kind": "inbound",
                "message_id": root.id,
                "from_name": reply.from_name or reply.from_email,
                "from_email": reply.from_email,
                "to_label": reply.to_email or root.from_email or "you",
                "subject": reply.subject,
                "snippet": reply.snippet or " ".join((reply.body_text or "").split())[:160],
                "body_text": reply.body_text,
                "body_html": reply.body_html,
                "occurred_at": iso(reply.occurred_at or reply.created_at),
                "follow_up_index": None,
            }
        )
    items.sort(key=lambda row: row.get("occurred_at") or "")
    # Keep current message context available without dropping others.
    _ = current
    return items


@router.post("/messages/sync-replies-all")
def sync_all_replies(ctx: Ctx = Depends(get_ctx), limit: int = Query(25, ge=1, le=50)):
    """Auto-sync recipient replies across recent open conversations."""
    ctx.require("member")
    return sync_workspace_replies(ctx.db, ctx.workspace.id, ctx.user, limit=limit)


@router.post("/messages/{message_id}/sync-replies")
def sync_replies(message_id: str, ctx: Ctx = Depends(get_ctx)):
    """Fetch recipient replies from the Gmail thread into MailInsider."""
    ctx.require("member")
    message = _owned(ctx, message_id)
    result = sync_thread_replies(ctx.db, message, ctx.user)
    detail = get_message(root_message(ctx.db, message).id, ctx)
    detail["sync"] = {
        "synced": result.get("synced", 0),
        "new": result.get("new", 0),
        "demo": result.get("demo", False),
        "note": result.get("note"),
    }
    return detail


@router.post("/messages/{message_id}/conversation")
def classify_conversation(message_id: str, payload: ConversationActionIn, ctx: Ctx = Depends(get_ctx)):
    """Classify conversation after a reply (or end / dead mail)."""
    ctx.require("member")
    message = _owned(ctx, message_id)
    root = root_message(ctx.db, message)
    now = utcnow()
    if payload.action == "continue_3":
        root.conversation_status = "awaiting_reply"
        root.next_follow_up_at = now + timedelta(days=FOLLOW_UP_CADENCE_DAYS)
    elif payload.action == "wait_7":
        root.conversation_status = "replied"
        root.next_follow_up_at = now + timedelta(days=7)
    elif payload.action == "end":
        root.conversation_status = "ended"
        root.next_follow_up_at = None
    elif payload.action == "dead":
        root.conversation_status = "dead"
        root.next_follow_up_at = None
    else:  # mark_replied
        root.conversation_status = "replied"
        # Keep existing schedule until they choose continue / wait_7 / end / dead.
    recipients = (
        ctx.db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == root.id, MessageRecipient.recipient_type == "to")
        .all()
    )
    for recipient in recipients:
        if not recipient.contact_id:
            continue
        contact = ctx.db.get(Contact, recipient.contact_id)
        if contact is None:
            continue
        if payload.action == "end":
            contact.pipeline_status = "closed"
            contact.next_follow_up_at = None
        elif payload.action == "dead":
            contact.pipeline_status = "no_response"
            contact.next_follow_up_at = None
        elif payload.action in {"continue_3", "wait_7"}:
            contact.next_follow_up_at = root.next_follow_up_at
            contact.pipeline_status = "replied" if payload.action == "wait_7" else "follow_up_due"
        else:
            contact.pipeline_status = "replied"
    ctx.db.commit()
    return get_message(root.id, ctx)


@router.patch("/messages/{message_id}")
def update_draft(message_id: str, payload: MessageIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    message = _owned(ctx, message_id)
    if message.send_status != "draft":
        raise AppError(400, "not_draft", "Only drafts can be edited. Sent messages stay as a record.")
    payload.send = False
    _apply_content(ctx, message, payload)
    _replace_recipients(ctx, message, payload)
    ctx.db.commit()
    return get_message(message.id, ctx)


@router.delete("/messages/{message_id}")
def delete_message(message_id: str, ctx: Ctx = Depends(get_ctx)):
    """Remove a draft or sent message from MailInsider (does not unsending Gmail)."""
    ctx.require("member")
    message = _owned(ctx, message_id)
    # Keep follow-ups; only clear the parent link before deleting this row.
    ctx.db.query(Message).filter(Message.parent_message_id == message.id).update(
        {Message.parent_message_id: None},
        synchronize_session=False,
    )
    recipient_ids = [
        row[0]
        for row in ctx.db.query(MessageRecipient.id).filter(MessageRecipient.message_id == message.id).all()
    ]
    if recipient_ids:
        ctx.db.query(TrackingLink).filter(TrackingLink.message_recipient_id.in_(recipient_ids)).delete(
            synchronize_session=False
        )
        ctx.db.query(UnsubscribeToken).filter(UnsubscribeToken.message_recipient_id.in_(recipient_ids)).delete(
            synchronize_session=False
        )
        ctx.db.query(DocumentAccessToken).filter(
            DocumentAccessToken.message_recipient_id.in_(recipient_ids)
        ).delete(synchronize_session=False)
        ctx.db.query(SheetLog).filter(SheetLog.message_recipient_id.in_(recipient_ids)).delete(
            synchronize_session=False
        )
    ctx.db.query(OpenToken).filter(OpenToken.message_id == message.id).delete(synchronize_session=False)
    ctx.db.query(MessageReply).filter(MessageReply.message_id == message.id).delete(synchronize_session=False)
    ctx.db.query(TrackingEvent).filter(TrackingEvent.message_id == message.id).delete(synchronize_session=False)
    ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id == message.id).delete(synchronize_session=False)
    ctx.db.delete(message)
    ctx.db.commit()
    return {"deleted": True}


@router.post("/messages/{message_id}/send")
def send_draft(message_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    message = _owned(ctx, message_id)
    if message.send_status != "draft":
        raise AppError(400, "not_draft", "This message has already been sent or queued.")
    recipients = ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id == message.id).all()
    to_count = len([item for item in recipients if item.recipient_type == "to"])
    if to_count == 0:
        raise AppError(400, "recipients_required", "Add at least one To recipient.")
    if sends_today(ctx.db, ctx.workspace.id) + to_count > get_settings().daily_send_limit:
        raise AppError(429, "quota", "This workspace has reached today's send limit.")
    if not message.subject.strip() or message.subject == "(no subject)":
        raise AppError(400, "subject_required", "Add a subject before sending.")
    message = queue_message(ctx.db, message, ctx.user, 30 if message.document_id else None)
    return get_message(message.id, ctx)


@router.get("/messages/{message_id}/events")
def message_events(message_id: str, ctx: Ctx = Depends(get_ctx)):
    message = _owned(ctx, message_id)
    events = (
        ctx.db.query(TrackingEvent)
        .filter(TrackingEvent.message_id == message.id)
        .order_by(TrackingEvent.occurred_at.asc())
        .limit(300)
        .all()
    )
    recipients = {
        row.id: row.email_snapshot
        for row in ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id == message.id).all()
    }
    return {
        "events": [
            {
                "id": event.id,
                "event_type": event.event_type,
                "source": event.source,
                "occurred_at": iso(event.occurred_at),
                "recipient_id": event.message_recipient_id,
                "recipient_email": recipients.get(event.message_recipient_id or "", None),
                "possible_automated": automated(event),
                "counts_toward_metric": counts(event),
                "metadata": public_details(event.details),
            }
            for event in events
        ]
    }


@router.post("/messages/{message_id}/retry")
def retry(message_id: str, payload: RetryIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    message = _owned(ctx, message_id)
    if message.is_sample and message.send_status == "failed":
        message.is_sample = False
    retry_message(ctx.db, message, ctx.user, payload.confirm_duplicate)
    return get_message(message.id, ctx)


@router.delete("/messages/{message_id}/tracking")
def revoke(message_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    message = _owned(ctx, message_id)
    revoke_tracking(ctx.db, message, ctx.user)
    return get_message(message.id, ctx)


@router.get("/messages/{message_id}/recipients/{recipient_id}/preview")
def preview(message_id: str, recipient_id: str, ctx: Ctx = Depends(get_ctx)):
    message = _owned(ctx, message_id)
    recipient = (
        ctx.db.query(MessageRecipient)
        .filter(
            MessageRecipient.id == recipient_id,
            MessageRecipient.message_id == message.id,
            MessageRecipient.workspace_id == ctx.workspace.id,
        )
        .one_or_none()
    )
    if recipient is None or not recipient.rendered_html:
        raise AppError(404, "not_found", "A prepared preview is available after the message is queued.")
    # Never load the live tracking GIF in the sender's browser.
    import re

    safe_html = re.sub(
        r'<img[^>]+(?:open-pixel|/t/open/)[^>]*>',
        '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="1" height="1" alt="" />',
        recipient.rendered_html,
        flags=re.IGNORECASE,
    )
    return {
        "html": safe_html,
        "notice": "Preview uses a placeholder for the open pixel so it does not record an open.",
    }


def _owned(ctx: Ctx, message_id: str) -> Message:
    message = (
        ctx.db.query(Message)
        .filter(Message.id == message_id, Message.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if message is None:
        raise AppError(404, "not_found", "That message is not in this workspace.")
    return message


def _parse_range(start: str | None, end: str | None) -> tuple[datetime, datetime]:
    finish = datetime.fromisoformat(end) if end else utcnow()
    begin = datetime.fromisoformat(start) if start else finish - timedelta(days=7)
    if begin.tzinfo is None:
        begin = begin.replace(tzinfo=timezone.utc)
    if finish.tzinfo is None:
        finish = finish.replace(tzinfo=timezone.utc)
    if finish <= begin:
        raise AppError(400, "invalid_range", "The end of the range has to be after the start.")
    if finish - begin > timedelta(days=366):
        raise AppError(400, "invalid_range", "Choose a range of 366 days or fewer.")
    return begin, finish


@router.get("/analytics/overview")
def overview(
    ctx: Ctx = Depends(get_ctx),
    start: str | None = Query(default=None, alias="from"),
    end: str | None = Query(default=None, alias="to"),
):
    return _overview(ctx, start, end)


def _overview(ctx: Ctx, start: str | None, end: str | None) -> dict:
    begin, finish = _parse_range(start, end)
    messages = (
        ctx.db.query(Message)
        .filter(
            Message.workspace_id == ctx.workspace.id,
            Message.created_at >= begin,
            Message.created_at < finish,
            Message.send_status != "draft",
        )
        .all()
    )
    ids = [item.id for item in messages]
    recipients = (
        ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id.in_(ids), MessageRecipient.recipient_type == "to").all()
        if ids
        else []
    )
    events = (
        ctx.db.query(TrackingEvent)
        .filter(
            TrackingEvent.workspace_id == ctx.workspace.id,
            TrackingEvent.occurred_at >= begin,
            TrackingEvent.occurred_at < finish,
        )
        .all()
    )
    day_ago = utcnow() - timedelta(days=1)
    recent = [event for event in events if as_utc(event.occurred_at) >= day_ago]

    def unique(event_type: str, source_events: list[TrackingEvent]) -> int:
        return len(
            {
                event.message_recipient_id
                for event in source_events
                if event.event_type == event_type and counts(event) and event.message_recipient_id
            }
        )

    sent = len([item for item in recipients if item.send_status == "sent"])
    failed = len([item for item in recipients if item.send_status == "failed"])
    no_activity = 0
    sent_messages = [item for item in messages if item.send_status == "sent"]
    for message in sent_messages:
        message_events = [event for event in events if event.message_id == message.id and event.event_type in ENGAGEMENT_TYPES]
        if not message_events:
            no_activity += 1
    return {
        "from": iso(begin),
        "to": iso(finish),
        "messages": len(messages),
        "sent_recipients": sent,
        "failed_recipients": failed,
        "unique_opens_estimated": unique("open_pixel_requested", events),
        "unique_clickers": unique("tracked_link_requested", events),
        "document_views": unique("document_view_started", events),
        "no_activity": no_activity,
        "since_yesterday": {
            "opens": unique("open_pixel_requested", recent),
            "clicks": unique("tracked_link_requested", recent),
            "document_views": unique("document_view_started", recent),
        },
        "quota": {"used": sends_today(ctx.db, ctx.workspace.id), "limit": get_settings().daily_send_limit},
    }


def _rate(part: int, whole: int) -> float | None:
    if whole <= 0:
        return None
    return round(part * 1000 / whole) / 10


def _change(current: int, previous: int) -> float | None:
    if previous <= 0:
        return None
    return round((current - previous) * 1000 / previous) / 10


def _bucket_start(moment: datetime, grain: str):
    moment = as_utc(moment)
    if moment is None:
        return None
    day = moment.date()
    if grain == "weekly":
        day = day - timedelta(days=day.weekday())
    return day


def _iter_buckets(begin: datetime, finish: datetime, grain: str):
    cursor = _bucket_start(begin, grain)
    last = _bucket_start(finish - timedelta(microseconds=1), grain)
    if cursor is None or last is None:
        return
    step = timedelta(days=7 if grain == "weekly" else 1)
    while cursor <= last:
        yield cursor
        cursor = cursor + step


def _window_rows(ctx: Ctx, begin: datetime, finish: datetime):
    messages = (
        ctx.db.query(Message)
        .filter(
            Message.workspace_id == ctx.workspace.id,
            Message.created_at >= begin,
            Message.created_at < finish,
            Message.send_status != "draft",
        )
        .all()
    )
    ids = [item.id for item in messages]
    recipients = (
        ctx.db.query(MessageRecipient)
        .filter(MessageRecipient.message_id.in_(ids), MessageRecipient.recipient_type == "to")
        .all()
        if ids
        else []
    )
    events = (
        ctx.db.query(TrackingEvent)
        .filter(
            TrackingEvent.workspace_id == ctx.workspace.id,
            TrackingEvent.occurred_at >= begin,
            TrackingEvent.occurred_at < finish,
        )
        .all()
    )
    return messages, recipients, events


def _metric_block(recipients: list[MessageRecipient], events: list[TrackingEvent]) -> dict:
    sent = len([item for item in recipients if item.send_status == "sent"])

    def unique(event_type: str) -> int:
        return len(
            {
                event.message_recipient_id
                for event in events
                if event.event_type == event_type and counts(event) and event.message_recipient_id
            }
        )

    opens = unique("open_pixel_requested")
    clicks = unique("tracked_link_requested")
    views = unique("document_view_started")
    return {
        "emails_sent": sent,
        "estimated_opens": opens,
        "link_clicks": clicks,
        "document_views": views,
        "open_rate": _rate(opens, sent),
        "click_rate": _rate(clicks, sent),
        "document_rate": _rate(views, sent),
    }


def _series(messages: list[Message], recipients: list[MessageRecipient], events: list[TrackingEvent], begin: datetime, finish: datetime, grain: str):
    buckets = {day: {"emails_sent": 0, "opens": set(), "clicks": set(), "views": set()} for day in _iter_buckets(begin, finish, grain)}
    by_id = {item.id: item for item in messages}
    for recipient in recipients:
        if recipient.send_status != "sent":
            continue
        message = by_id.get(recipient.message_id)
        if message is None:
            continue
        stamp = as_utc(message.sent_at) or as_utc(message.created_at)
        if stamp is None or stamp < begin or stamp >= finish:
            stamp = as_utc(message.created_at)
        if stamp is None:
            continue
        key = _bucket_start(stamp, grain)
        if key in buckets:
            buckets[key]["emails_sent"] += 1
    kind = {
        "open_pixel_requested": "opens",
        "tracked_link_requested": "clicks",
        "document_view_started": "views",
    }
    for event in events:
        slot = kind.get(event.event_type)
        if slot is None or not counts(event) or not event.message_recipient_id:
            continue
        stamp = as_utc(event.occurred_at)
        if stamp is None:
            continue
        key = _bucket_start(stamp, grain)
        if key in buckets:
            buckets[key][slot].add(event.message_recipient_id)
    return [
        {
            "date": day.isoformat(),
            "emails_sent": row["emails_sent"],
            "estimated_opens": len(row["opens"]),
            "link_clicks": len(row["clicks"]),
            "document_views": len(row["views"]),
        }
        for day, row in buckets.items()
    ]


@router.get("/analytics/performance")
def performance(
    ctx: Ctx = Depends(get_ctx),
    start: str | None = Query(default=None, alias="from"),
    end: str | None = Query(default=None, alias="to"),
    grain: str = "daily",
):
    if grain not in {"daily", "weekly"}:
        raise AppError(400, "invalid_grain", "Choose daily or weekly.")
    begin, finish = _parse_range(start, end)
    span = finish - begin
    current_messages, current_recipients, current_events = _window_rows(ctx, begin, finish)
    _previous_messages, previous_recipients, previous_events = _window_rows(ctx, begin - span, begin)
    current = _metric_block(current_recipients, current_events)
    previous = _metric_block(previous_recipients, previous_events)
    return {
        "from": iso(begin),
        "to": iso(finish),
        "grain": grain,
        "definitions": {
            "emails_sent": "To recipients accepted by the provider on messages created in the range.",
            "estimated_opens": "Distinct recipients with at least one open.",
            "link_clicks": "Distinct recipients with at least one counted tracked-link request.",
            "document_views": "Distinct recipients with at least one counted document view.",
            "rates": "Each rate uses emails sent as the denominator. The value is omitted when nothing was sent.",
            "comparison": "Change versus the previous window of the same length. Omitted when that window is zero.",
            "series": "Each point counts distinct recipients that day or week. Adding the points can exceed the period total.",
        },
        "current": current,
        "previous": previous,
        "comparison": {
            "emails_sent": _change(current["emails_sent"], previous["emails_sent"]),
            "estimated_opens": _change(current["estimated_opens"], previous["estimated_opens"]),
            "link_clicks": _change(current["link_clicks"], previous["link_clicks"]),
            "document_views": _change(current["document_views"], previous["document_views"]),
        },
        "series": _series(current_messages, current_recipients, current_events, begin, finish, grain),
    }


ACTIVITY_KINDS = {
    "message_send_succeeded": "email_sent",
    "message_send_failed": "send_failed",
    "open_pixel_requested": "estimated_open",
    "tracked_link_requested": "link_click",
    "document_view_started": "document_view",
}


@router.get("/analytics/activity")
def activity(ctx: Ctx = Depends(get_ctx), limit: int = Query(12, ge=1, le=50)):
    events = (
        ctx.db.query(TrackingEvent)
        .filter(
            TrackingEvent.workspace_id == ctx.workspace.id,
            TrackingEvent.event_type.in_(tuple(ACTIVITY_KINDS)),
        )
        .order_by(TrackingEvent.occurred_at.desc())
        .limit(limit)
        .all()
    )
    message_ids = {event.message_id for event in events if event.message_id}
    recipient_ids = {event.message_recipient_id for event in events if event.message_recipient_id}
    messages = (
        {row.id: row for row in ctx.db.query(Message).filter(Message.id.in_(message_ids)).all()} if message_ids else {}
    )
    recipients = (
        {row.id: row for row in ctx.db.query(MessageRecipient).filter(MessageRecipient.id.in_(recipient_ids)).all()}
        if recipient_ids
        else {}
    )
    items = []
    for event in events:
        recipient = recipients.get(event.message_recipient_id or "")
        message = messages.get(event.message_id or "")
        actor = None
        if recipient is not None:
            actor = recipient.display_name_snapshot or recipient.email_snapshot
        items.append(
            {
                "id": event.id,
                "kind": ACTIVITY_KINDS[event.event_type],
                "actor": actor,
                "subject": message.subject if message else None,
                "message_id": event.message_id,
                "occurred_at": iso(event.occurred_at),
                "possible_automated": automated(event),
                "counts_toward_metric": counts(event),
            }
        )
    reauth = (
        ctx.db.query(GmailConnection)
        .filter(GmailConnection.workspace_id == ctx.workspace.id, GmailConnection.status == "needs_reauth")
        .all()
    )
    for row in reauth:
        items.append(
            {
                "id": f"gmail-{row.id}",
                "kind": "gmail_reauth",
                "actor": row.google_account_email,
                "subject": None,
                "message_id": None,
                "occurred_at": iso(row.updated_at),
                "possible_automated": False,
                "counts_toward_metric": False,
            }
        )
    items.sort(key=lambda item: item["occurred_at"] or "", reverse=True)
    return {"items": items[:limit]}


@router.get("/analytics/messages/{message_id}")
def message_analytics(message_id: str, ctx: Ctx = Depends(get_ctx)):
    message = _owned(ctx, message_id)
    recipients = ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id == message.id).all()
    events = _events_for(ctx.db, [message.id])
    demos = _demo_map(ctx.db, [message])
    summary = _summary(message, recipients, events, demos.get(message.gmail_connection_id or "", False))
    return {"message": summary, "recipients": [_recipient_payload(item, events) for item in recipients]}


@router.get("/analytics/recipients/{recipient_id}")
def recipient_analytics(recipient_id: str, ctx: Ctx = Depends(get_ctx)):
    recipient = (
        ctx.db.query(MessageRecipient)
        .filter(MessageRecipient.id == recipient_id, MessageRecipient.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if recipient is None:
        raise AppError(404, "not_found", "That recipient is not in this workspace.")
    events = (
        ctx.db.query(TrackingEvent)
        .filter(TrackingEvent.message_recipient_id == recipient.id)
        .order_by(TrackingEvent.occurred_at.asc())
        .all()
    )
    return {
        "recipient": _recipient_payload(recipient, events),
        "events": [
            {
                "id": event.id,
                "event_type": event.event_type,
                "occurred_at": iso(event.occurred_at),
                "possible_automated": automated(event),
                "metadata": public_details(event.details),
            }
            for event in events
        ],
    }
