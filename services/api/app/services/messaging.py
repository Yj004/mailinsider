import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import hash_token, new_token
from app.errors import AppError
from email.utils import parseaddr

from app.models import (
    AiProfile,
    Contact,
    DocumentAccessToken,
    DocumentAsset,
    GmailConnection,
    Message,
    MessageRecipient,
    MessageReply,
    OpenToken,
    SheetConnection,
    SheetLog,
    Suppression,
    TrackingLink,
    UnsubscribeToken,
    User,
    Workspace,
    as_utc,
    new_id,
    utcnow,
)
from app.services.document_storage import get_bytes
from app.services.personalize import merge_fields, render_text
from app.services.events import audit, record_event
from app.services.gmail import (
    AmbiguousSend,
    NeedsReauth,
    PermanentSend,
    TransientSend,
    build_mime,
    deliver,
    fetch_rfc_message_id,
    fetch_thread,
    resolve_thread_id,
)
from html import escape

from app.services.render import html_to_text, is_safe_http_url, plain_to_html, rewrite_html_links, sanitize_html
from app.services.sheets import append_send_row, is_sheet_attached, row_values

log = logging.getLogger("mailinsider.send")

FOLLOW_UP_CADENCE_DAYS = 3


def root_message(db: Session, message: Message) -> Message:
    if message.parent_message_id:
        parent = db.get(Message, message.parent_message_id)
        if parent is not None:
            return parent
    return message


def schedule_follow_up(db: Session, message: Message, *, days: int = FOLLOW_UP_CADENCE_DAYS) -> None:
    """After a successful send, schedule the next follow-up on the thread root."""
    root = root_message(db, message)
    if (root.conversation_status or "active") in {"ended", "dead"}:
        return
    if message.parent_message_id and message.id != root.id:
        index = int(message.follow_up_index or 0)
        if index <= 0:
            index = int(root.follow_up_count or 0) + 1
            message.follow_up_index = index
        root.follow_up_count = max(int(root.follow_up_count or 0), index)
    due = utcnow() + timedelta(days=days)
    root.next_follow_up_at = due
    root.conversation_status = "awaiting_reply"
    recipients = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == root.id, MessageRecipient.recipient_type == "to")
        .all()
    )
    for recipient in recipients:
        if not recipient.contact_id:
            continue
        contact = db.get(Contact, recipient.contact_id)
        if contact is None:
            continue
        contact.next_follow_up_at = due
        if (contact.pipeline_status or "to_contact") in {"to_contact", "draft", "sent", "open_detected", "link_clicked"}:
            contact.pipeline_status = "follow_up_due"


def _parse_occurred(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return as_utc(stamp)


def sync_thread_replies(db: Session, message: Message, user: User | None = None) -> dict:
    """Pull recipient replies from the Gmail thread into message_replies."""
    root = root_message(db, message)
    if not root.gmail_connection_id:
        raise AppError(400, "no_gmail", "This message was not sent through a Gmail connection.")
    connection = db.get(GmailConnection, root.gmail_connection_id)
    if connection is None or connection.workspace_id != root.workspace_id:
        raise AppError(400, "no_gmail", "Gmail is not connected for this message.")
    if connection.status == "needs_reauth":
        raise AppError(403, "needs_reauth", "Reconnect Gmail to sync replies.")

    thread_id = root.gmail_thread_id
    if not thread_id:
        recipients = (
            db.query(MessageRecipient)
            .filter(MessageRecipient.message_id == root.id, MessageRecipient.gmail_message_id.isnot(None))
            .all()
        )
        for recipient in recipients:
            if not recipient.gmail_message_id:
                continue
            try:
                thread_id = resolve_thread_id(connection, recipient.gmail_message_id)
            except NeedsReauth:
                connection.status = "needs_reauth"
                db.commit()
                raise AppError(403, "needs_reauth", "Reconnect Gmail to sync replies.")
            if thread_id:
                root.gmail_thread_id = thread_id
                break
    if not thread_id:
        if connection.is_demo:
            return {"replies": [], "synced": 0, "new": 0, "demo": True, "note": "Demo Gmail has no inbox to sync."}
        raise AppError(
            400,
            "no_thread",
            "No Gmail thread is stored for this message yet. Send a new email after reconnecting Gmail, or sync after the first send.",
        )

    try:
        thread_messages = fetch_thread(connection, thread_id)
    except NeedsReauth:
        connection.status = "needs_reauth"
        db.commit()
        raise AppError(403, "needs_reauth", "Reconnect Gmail to sync replies.")
    except PermanentSend as exc:
        raise AppError(403, exc.code, exc.message) from exc
    except TransientSend as exc:
        raise AppError(502, exc.code, exc.message) from exc

    thread_messages = list(thread_messages)
    related = (
        db.query(Message)
        .filter(
            Message.workspace_id == root.workspace_id,
            (Message.id == root.id) | (Message.parent_message_id == root.id),
        )
        .all()
    )
    related_ids = [item.id for item in related]
    outbound_ids = {
        item.gmail_message_id
        for item in db.query(MessageRecipient).filter(MessageRecipient.message_id.in_(related_ids)).all()
        if item.gmail_message_id
    }
    our_emails = {(root.from_email or "").lower(), (connection.google_account_email or "").lower()}
    our_emails.discard("")
    recipient_emails = {
        item.email_snapshot.lower()
        for item in db.query(MessageRecipient)
        .filter(MessageRecipient.message_id.in_(related_ids), MessageRecipient.recipient_type == "to")
        .all()
    }

    existing = {
        row.gmail_message_id: row
        for row in db.query(MessageReply)
        .filter(MessageReply.workspace_id == root.workspace_id, MessageReply.message_id == root.id)
        .all()
    }
    new_count = 0
    inbound_seen = 0
    for item in thread_messages:
        gmail_id = item.get("gmail_message_id") or ""
        if not gmail_id or gmail_id in outbound_ids:
            continue
        from_name, from_addr = parseaddr(item.get("from_header") or "")
        from_email = (from_addr or "").strip().lower()
        if not from_email:
            continue
        if from_email in our_emails:
            continue
        label_ids = {str(label) for label in (item.get("label_ids") or [])}
        # Prefer recipient-side mail; still accept if From matches a To address.
        if from_email not in recipient_emails and "SENT" in label_ids and "INBOX" not in label_ids:
            continue
        inbound_seen += 1
        _, to_addr = parseaddr(item.get("to_header") or "")
        occurred = _parse_occurred(item.get("occurred_at"))
        body_html = item.get("body_html") or ""
        body_text = item.get("body_text") or ""
        if body_html:
            body_html = sanitize_html(body_html)
            if not body_text:
                body_text = html_to_text(body_html)
        row = existing.get(gmail_id)
        if row is None:
            row = MessageReply(
                workspace_id=root.workspace_id,
                message_id=root.id,
                gmail_message_id=gmail_id,
            )
            db.add(row)
            existing[gmail_id] = row
            new_count += 1
        row.gmail_thread_id = item.get("gmail_thread_id") or thread_id
        row.rfc_message_id = (item.get("rfc_message_id") or "").strip()[:320] or row.rfc_message_id
        row.direction = "inbound"
        row.from_email = from_email
        row.from_name = (from_name or "").strip()[:160] or None
        row.to_email = (to_addr or "").strip().lower()[:320] or None
        row.subject = (item.get("subject") or "")[:500] or None
        row.snippet = (item.get("snippet") or "")[:2000] or None
        row.body_text = body_text[:50_000] if body_text else None
        row.body_html = body_html[:100_000] if body_html else None
        row.occurred_at = occurred

    if inbound_seen and (root.conversation_status or "active") not in {"ended", "dead"}:
        root.conversation_status = "replied"
        for recipient in (
            db.query(MessageRecipient)
            .filter(MessageRecipient.message_id == root.id, MessageRecipient.recipient_type == "to")
            .all()
        ):
            if not recipient.contact_id:
                continue
            contact = db.get(Contact, recipient.contact_id)
            if contact is not None and (contact.pipeline_status or "") not in {"closed", "no_response"}:
                contact.pipeline_status = "replied"

    if user is not None:
        audit(
            db,
            workspace_id=root.workspace_id,
            actor_user_id=user.id,
            action="message.sync_replies",
            target_type="message",
            target_id=root.id,
            details={"synced": inbound_seen, "new": new_count, "thread_id": thread_id},
        )
    db.commit()
    replies = (
        db.query(MessageReply)
        .filter(MessageReply.message_id == root.id)
        .order_by(MessageReply.occurred_at.asc().nullslast(), MessageReply.created_at.asc())
        .all()
    )
    return {
        "replies": [reply_payload(row) for row in replies],
        "synced": inbound_seen,
        "new": new_count,
        "demo": bool(connection.is_demo),
        "gmail_thread_id": thread_id,
    }


def reply_payload(row: MessageReply) -> dict:
    from app.services.signals import iso

    return {
        "id": row.id,
        "gmail_message_id": row.gmail_message_id,
        "gmail_thread_id": row.gmail_thread_id,
        "direction": row.direction,
        "from_email": row.from_email,
        "from_name": row.from_name,
        "to_email": row.to_email,
        "subject": row.subject,
        "snippet": row.snippet,
        "body_text": row.body_text,
        "body_html": row.body_html,
        "occurred_at": iso(row.occurred_at) if row.occurred_at else iso(row.created_at),
    }


def sync_workspace_replies(db: Session, workspace_id: str, user: User | None = None, *, limit: int = 25) -> dict:
    """Auto-sync recipient replies for recent open outbound threads."""
    roots = (
        db.query(Message)
        .filter(
            Message.workspace_id == workspace_id,
            Message.parent_message_id.is_(None),
            Message.send_status.in_(("sent", "partial")),
            Message.conversation_status.notin_(("ended", "dead")),
        )
        .order_by(Message.sent_at.desc().nullslast(), Message.created_at.desc())
        .limit(max(1, min(limit, 50)))
        .all()
    )
    threads = 0
    new_replies = 0
    errors = 0
    for root in roots:
        try:
            result = sync_thread_replies(db, root, user)
        except AppError:
            errors += 1
            continue
        threads += 1
        new_replies += int(result.get("new") or 0)
    return {"threads": threads, "new_replies": new_replies, "errors": errors, "checked": len(roots)}


PERMANENT_CODES = {"invalid_recipient", "unauthorized", "forbidden"}
ROLE_RANK = {"viewer": 1, "member": 2, "admin": 3, "owner": 4}


def normalize_address(email: str, name: str | None) -> tuple[str, str | None]:
    from email_validator import EmailNotValidError, validate_email

    try:
        cleaned = validate_email(email.strip(), check_deliverability=False).normalized.lower()
    except EmailNotValidError as exc:
        raise AppError(400, "invalid_email", "One of the recipient addresses is not valid.") from exc
    display = (name or "").replace("\r", " ").replace("\n", " ").strip() or None
    if display and len(display) > 160:
        raise AppError(400, "invalid_name", "Recipient names must be 160 characters or fewer.")
    return cleaned, display


def _contact_fields(recipient: MessageRecipient, contact: Contact | None) -> dict[str, str]:
    custom = dict(contact.custom_fields or {}) if contact else {}
    if contact:
        if contact.company:
            custom.setdefault("company", contact.company)
        if contact.job_title:
            custom.setdefault("job_title", contact.job_title)
        if contact.target_role:
            custom.setdefault("role", contact.target_role)
            custom.setdefault("target_role", contact.target_role)
    return merge_fields(recipient.email_snapshot, recipient.display_name_snapshot, custom)


def upsert_contact(
    db: Session,
    workspace_id: str,
    email: str,
    name: str | None,
    *,
    custom_fields: dict | None = None,
    source: str | None = None,
) -> Contact:
    contact = (
        db.query(Contact)
        .filter(Contact.workspace_id == workspace_id, Contact.email == email)
        .one_or_none()
    )
    if contact:
        if name and contact.display_name != name:
            contact.display_name = name
        if custom_fields:
            merged = dict(contact.custom_fields or {})
            merged.update({str(k): ("" if v is None else str(v)) for k, v in custom_fields.items()})
            contact.custom_fields = merged
        if source:
            contact.source = source
        return contact
    contact = Contact(
        workspace_id=workspace_id,
        email=email,
        display_name=name,
        custom_fields={str(k): ("" if v is None else str(v)) for k, v in (custom_fields or {}).items()},
        source=source,
    )
    db.add(contact)
    db.flush()
    return contact


def is_suppressed(db: Session, workspace_id: str, email: str) -> bool:
    return (
        db.query(Suppression.id)
        .filter(Suppression.workspace_id == workspace_id, Suppression.email == email)
        .first()
        is not None
    )


def add_suppression(
    db: Session,
    *,
    workspace_id: str,
    email: str,
    reason: str = "unsubscribe",
    source: str = "user",
    message_id: str | None = None,
) -> Suppression:
    existing = (
        db.query(Suppression)
        .filter(Suppression.workspace_id == workspace_id, Suppression.email == email)
        .one_or_none()
    )
    if existing:
        return existing
    row = Suppression(
        workspace_id=workspace_id,
        email=email,
        reason=reason,
        source=source,
        message_id=message_id,
    )
    db.add(row)
    db.flush()
    return row


def _body_html(body_text: str, body_html: str | None) -> str:
    if body_html and body_html.strip():
        return sanitize_html(body_html)
    return plain_to_html(body_text or "")


def _pixel_tag(token: str) -> str:
    settings = get_settings()
    base = (settings.public_open_pixel_url or "").rstrip("/")
    if not base:
        base = f"{settings.public_api_url.rstrip('/')}/t/open"
    src = f"{base}/{token}.gif"
    return (
        f'<img src="{src}" width="1" height="1" alt="" '
        'style="display:block;width:1px;height:1px;border:0;overflow:hidden" />'
    )


def _append_document_link(html: str, filename: str, url: str) -> str:
    return (
        html
        + f'<p><a href="{escape(url, quote=True)}">View document: {escape(filename)}</a></p>'
    )


def _append_signature(html: str, *, signature_text: str | None = None) -> str:
    from app.services.signature import signature_already_present, signature_html

    # AI drafts already include the full signature — don't append a second copy on send.
    if signature_already_present(html, signature_text):
        return html
    return html + signature_html(signature_text)


def _append_sheet_link(html: str, title: str, url: str) -> str:
    if not url.startswith("https://docs.google.com/spreadsheets/"):
        return html + "<p>This send is recorded on the workspace sheet inside MailInsider.</p>"
    return html + f'<p><a href="{escape(url, quote=True)}">Open the workspace sheet: {escape(title)}</a></p>'


def pdf_attachment(document: DocumentAsset | None, attach: bool) -> tuple[str | None, bytes | None]:
    if not attach or document is None or document.content_type != "application/pdf":
        return None, None
    data = get_bytes(document.storage_path)
    if data is None:
        return None, None
    return document.filename, data


def render_recipient(
    db: Session,
    message: Message,
    recipient: MessageRecipient,
    document: DocumentAsset | None,
    expires_at: datetime | None,
    sheet: SheetConnection | None = None,
) -> None:
    contact = db.get(Contact, recipient.contact_id) if recipient.contact_id else None
    fields = _contact_fields(recipient, contact)
    personalized_text = render_text(message.body_text or "", fields)
    personalized_html = render_text(message.body_html or "", fields) if message.body_html else None
    html = _body_html(personalized_text, personalized_html)
    profile = db.query(AiProfile).filter(AiProfile.workspace_id == message.workspace_id).one_or_none()
    sig_text = (profile.email_signature or "").strip() if profile else ""
    html = _append_signature(html, signature_text=sig_text or None)
    if document:
        raw = new_token()
        db.add(
            DocumentAccessToken(
                workspace_id=message.workspace_id,
                document_id=document.id,
                message_recipient_id=recipient.id,
                token_hash=hash_token(raw),
                expires_at=expires_at,
            )
        )
        from app.services.public_links import public_document_url

        url = public_document_url(raw)
        html = _append_document_link(html, document.filename, url)
    if message.include_sheet_link and sheet is not None:
        html = _append_sheet_link(html, sheet.spreadsheet_title, sheet.spreadsheet_url)

    from app.services.public_links import is_mailinsider_tracking_url, public_click_url, public_unsubscribe_url

    def replace(url: str) -> str:
        if not message.link_tracking:
            return url
        if url.startswith("mailto:"):
            return url
        if is_mailinsider_tracking_url(url):
            return url
        if not is_safe_http_url(url):
            return url
        raw = new_token()
        db.add(
            TrackingLink(
                workspace_id=message.workspace_id,
                message_recipient_id=recipient.id,
                token_hash=hash_token(raw),
                destination_url=url,
            )
        )
        return public_click_url(raw)

    if message.link_tracking:
        html = rewrite_html_links(html, replace)
    # Campaign / marketing sends keep an unsubscribe link. Ordinary one-to-one
    # outreach should read like personal correspondence, not a newsletter.
    if message.campaign_id:
        unsub_raw = new_token()
        db.add(
            UnsubscribeToken(
                workspace_id=message.workspace_id,
                message_recipient_id=recipient.id,
                email=recipient.email_snapshot,
                token_hash=hash_token(unsub_raw),
            )
        )
        unsub_url = public_unsubscribe_url(unsub_raw)
        html += (
            '<p style="font-size:12px;color:#666;margin-top:24px">'
            f'<a href="{escape(unsub_url, quote=True)}">Unsubscribe</a></p>'
        )
    if message.open_tracking and recipient.recipient_type == "to":
        # One active GIF per recipient address: revoke older pixels so opening
        # a newer email cannot attribute opens to prior sends (Gmail prefetch).
        peer_ids = [
            row[0]
            for row in db.query(MessageRecipient.id)
            .filter(
                MessageRecipient.workspace_id == message.workspace_id,
                MessageRecipient.recipient_type == "to",
                MessageRecipient.email_snapshot == recipient.email_snapshot,
            )
            .all()
        ]
        if peer_ids:
            db.query(OpenToken).filter(
                OpenToken.workspace_id == message.workspace_id,
                OpenToken.message_recipient_id.in_(peer_ids),
                OpenToken.message_id != message.id,
                OpenToken.revoked_at.is_(None),
            ).update({"revoked_at": utcnow()}, synchronize_session=False)
        raw = new_token()
        db.add(
            OpenToken(
                workspace_id=message.workspace_id,
                message_id=message.id,
                message_recipient_id=recipient.id,
                token_hash=hash_token(raw),
            )
        )
        html += _pixel_tag(raw)
    recipient.rendered_html = html
    recipient.rendered_text = html_to_text(html)


def queue_message(db: Session, message: Message, actor: User, document_expires_days: int | None) -> Message:
    connection = _connection_for(db, message)
    if connection is None or connection.status != "connected":
        raise AppError(400, "gmail_required", "Connect Gmail before sending. Owners and admins can connect an account.")
    recipients = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == message.id)
        .all()
    )
    tos = [item for item in recipients if item.recipient_type == "to"]
    copies = [item for item in recipients if item.recipient_type in {"cc", "bcc"}]
    if not tos:
        raise AppError(400, "recipients_required", "Add at least one To recipient.")
    if len(tos) > 1 and copies:
        raise AppError(
            400,
            "cc_with_multiple_to",
            "Cc and Bcc are only available with a single To recipient, so activity stays tied to one person.",
        )
    suppressed = []
    active_tos = []
    for recipient in tos:
        if is_suppressed(db, message.workspace_id, recipient.email_snapshot):
            recipient.send_status = "skipped"
            recipient.error_code = "suppressed"
            recipient.error_message = "This address is on the workspace suppression list."
            suppressed.append(recipient)
        else:
            active_tos.append(recipient)
    if not active_tos:
        raise AppError(
            400,
            "all_suppressed",
            "Every To recipient is suppressed or unsubscribed. Remove suppressions or choose other recipients.",
        )
    tos = active_tos
    document = None
    expires_at = None
    if message.document_id:
        document = (
            db.query(DocumentAsset)
            .filter(DocumentAsset.id == message.document_id, DocumentAsset.workspace_id == message.workspace_id)
            .one_or_none()
        )
        if document is None:
            raise AppError(404, "not_found", "That document is not in this workspace.")
        if document_expires_days:
            expires_at = utcnow() + timedelta(days=document_expires_days)
        if message.attach_pdf and document.content_type != "application/pdf":
            raise AppError(400, "pdf_required", "Only a PDF can be attached. Other files are sent as a view link.")
    elif message.attach_pdf:
        raise AppError(400, "pdf_required", "Choose a PDF before attaching it to the email.")
    sheet = None
    if message.include_sheet_link:
        sheet = (
            db.query(SheetConnection)
            .filter(SheetConnection.workspace_id == message.workspace_id, SheetConnection.status == "connected")
            .order_by(SheetConnection.created_at.desc())
            .first()
        )
        if sheet is None or not is_sheet_attached(sheet):
            raise AppError(
                400,
                "sheet_required",
                "Connect Google Sheets and attach a spreadsheet before including its link.",
            )
    message.gmail_connection_id = connection.id
    message.from_email = connection.google_account_email
    message.send_status = "queued"
    message.error_code = None
    message.error_message = None
    for recipient in tos:
        render_recipient(db, message, recipient, document, expires_at, sheet)
        recipient.send_status = "queued"
        recipient.next_attempt_at = utcnow()
        recipient.error_code = None
        recipient.error_message = None
    for recipient in copies:
        recipient.send_status = "queued"
        recipient.rendered_html = None
    record_event(
        db,
        workspace_id=message.workspace_id,
        message_id=message.id,
        event_type="message_queued",
        source="system",
        details={"counts_toward_metric": 0},
    )
    audit(
        db,
        workspace_id=message.workspace_id,
        actor_user_id=actor.id,
        action="message_queued",
        target_type="message",
        target_id=message.id,
        details={"subject": message.subject, "to_count": len(tos)},
    )
    db.commit()
    kick_sender()
    db.expire_all()
    db.refresh(message)
    return message


def _connection_for(db: Session, message: Message) -> GmailConnection | None:
    query = db.query(GmailConnection).filter(
        GmailConnection.workspace_id == message.workspace_id,
        GmailConnection.status == "connected",
    )
    if message.gmail_connection_id:
        return query.filter(GmailConnection.id == message.gmail_connection_id).one_or_none()
    return query.order_by(GmailConnection.created_at.desc()).first()


def rollup_status(db: Session, message: Message) -> None:
    recipients = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == message.id, MessageRecipient.recipient_type == "to")
        .all()
    )
    statuses = [item.send_status for item in recipients]
    if not statuses:
        message.send_status = "failed"
        return
    active = [item for item in statuses if item not in {"skipped", "cancelled"}]
    if not active:
        message.send_status = "cancelled" if any(item == "cancelled" for item in statuses) else "failed"
        return
    if any(item == "needs_review" for item in active):
        message.send_status = "needs_review"
    elif any(item in {"queued", "sending"} for item in active):
        message.send_status = "sending" if any(item == "sending" for item in active) else "queued"
    elif all(item == "sent" for item in active):
        message.send_status = "sent"
        message.sent_at = message.sent_at or utcnow()
    elif all(item == "failed" for item in active):
        message.send_status = "failed"
        message.error_message = next((item.error_message for item in recipients if item.error_message), None)
        message.error_code = next((item.error_code for item in recipients if item.error_code), None)
    elif any(item == "sent" for item in active):
        message.send_status = "partial"
        message.sent_at = message.sent_at or utcnow()
    else:
        message.send_status = active[0]


def process_one(db: Session) -> bool:
    now = utcnow()
    _sweep_stuck(db, now)
    candidate = (
        db.query(MessageRecipient)
        .filter(
            MessageRecipient.recipient_type == "to",
            MessageRecipient.send_status == "queued",
            (MessageRecipient.next_attempt_at.is_(None)) | (MessageRecipient.next_attempt_at <= now),
        )
        .order_by(MessageRecipient.created_at.asc())
        .first()
    )
    if candidate is None:
        return False
    claimed = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.id == candidate.id, MessageRecipient.send_status == "queued")
        .update({"send_status": "sending", "updated_at": now}, synchronize_session=False)
    )
    db.commit()
    if claimed != 1:
        return True
    recipient = db.get(MessageRecipient, candidate.id)
    message = db.get(Message, recipient.message_id)
    if recipient is None or message is None:
        return True
    try:
        _send_recipient(db, message, recipient)
    except Exception:
        log.exception("send_interrupted")
        recipient.send_status = "needs_review"
        recipient.error_code = "unknown"
        recipient.error_message = (
            "Sending was interrupted. Review this message before retrying so you do not send a duplicate."
        )
        record_event(
            db,
            workspace_id=message.workspace_id,
            message_id=message.id,
            message_recipient_id=recipient.id,
            event_type="message_send_failed",
            source="system",
            details={"error_code": "unknown", "counts_toward_metric": 0},
        )
    rollup_status(db, message)
    db.commit()
    return True


def _sweep_stuck(db: Session, now: datetime) -> None:
    cutoff = now - timedelta(minutes=2)
    stuck = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.send_status == "sending", MessageRecipient.updated_at < cutoff)
        .all()
    )
    for recipient in stuck:
        recipient.send_status = "needs_review"
        recipient.error_code = "unknown"
        recipient.error_message = (
            "Sending did not finish. Review before retrying so you do not send a duplicate."
        )
        message = db.get(Message, recipient.message_id)
        if message:
            rollup_status(db, message)
    if stuck:
        db.commit()


def _log_sheet(db: Session, message: Message, recipient: MessageRecipient) -> None:
    if not message.include_sheet_link:
        return
    if db.query(SheetLog).filter(SheetLog.message_recipient_id == recipient.id).one_or_none():
        return
    sheet = (
        db.query(SheetConnection)
        .filter(SheetConnection.workspace_id == message.workspace_id, SheetConnection.status == "connected")
        .order_by(SheetConnection.created_at.desc())
        .first()
    )
    if sheet is None or not is_sheet_attached(sheet):
        return
    values = row_values(
        sent_at=utcnow(),
        from_email=message.from_email or "",
        to_email=recipient.email_snapshot,
        subject=message.subject,
        attached=message.attach_pdf,
    )
    try:
        append_send_row(sheet, values)
    except Exception:
        log.warning("sheet row was not added for recipient %s", recipient.id)
        record_event(
            db,
            workspace_id=message.workspace_id,
            message_id=message.id,
            message_recipient_id=recipient.id,
            event_type="sheet_row_failed",
            source="system",
            details={"counts_toward_metric": 0},
        )
        return
    db.add(
        SheetLog(
            workspace_id=message.workspace_id,
            sheet_connection_id=sheet.id,
            message_id=message.id,
            message_recipient_id=recipient.id,
            details={"row": values, "demo": sheet.is_demo},
        )
    )
    record_event(
        db,
        workspace_id=message.workspace_id,
        message_id=message.id,
        message_recipient_id=recipient.id,
        event_type="sheet_row_appended",
        source="system",
        details={"demo": sheet.is_demo, "counts_toward_metric": 0},
    )


def _normalize_rfc_id(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    if not cleaned:
        return None
    if cleaned[0] != "<":
        cleaned = f"<{cleaned}>"
    return cleaned[:320]


def _make_rfc_message_id(from_email: str) -> str:
    domain = (from_email or "mailinsider.local").split("@")[-1].strip() or "mailinsider.local"
    return f"<{new_id()}@{domain}>"


def _thread_reply_headers(db: Session, message: Message, connection: GmailConnection) -> tuple[str | None, str | None, str | None]:
    """Return (gmail_thread_id, in_reply_to, references) so follow-ups stay in the same Gmail conversation."""
    root = root_message(db, message)
    # Always resolve threading against the root's mailbox — not a different connected account.
    thread_connection = connection
    if root.gmail_connection_id and root.gmail_connection_id != connection.id:
        root_conn = db.get(GmailConnection, root.gmail_connection_id)
        if root_conn and root_conn.status == "connected":
            thread_connection = root_conn

    thread_id = root.gmail_thread_id or message.gmail_thread_id
    if not thread_id:
        # Recover thread id from the first outbound Gmail message id on the root.
        anchor = (
            db.query(MessageRecipient)
            .filter(MessageRecipient.message_id == root.id, MessageRecipient.gmail_message_id.isnot(None))
            .order_by(MessageRecipient.created_at.asc())
            .first()
        )
        if anchor and anchor.gmail_message_id:
            try:
                thread_id = resolve_thread_id(thread_connection, anchor.gmail_message_id)
            except NeedsReauth:
                raise
            except Exception:
                thread_id = None
            if thread_id:
                root.gmail_thread_id = thread_id

    if not message.parent_message_id and not root.gmail_thread_id:
        return None, None, None

    if message.parent_message_id and not thread_id and not thread_connection.is_demo:
        raise PermanentSend(
            "no_thread",
            "Could not find the original Gmail thread. Reconnect Gmail with read access, open this conversation once to sync, then reply again.",
        )

    related = (
        db.query(Message)
        .filter(
            Message.workspace_id == root.workspace_id,
            (Message.id == root.id) | (Message.parent_message_id == root.id),
        )
        .order_by(Message.sent_at.asc().nullslast(), Message.created_at.asc())
        .all()
    )
    chain: list[str] = []
    for item in related:
        if item.id == message.id:
            continue
        rid = _normalize_rfc_id(item.rfc_message_id)
        if not rid and item.id == root.id:
            anchor = (
                db.query(MessageRecipient)
                .filter(MessageRecipient.message_id == root.id, MessageRecipient.gmail_message_id.isnot(None))
                .order_by(MessageRecipient.created_at.asc())
                .first()
            )
            if anchor and anchor.gmail_message_id:
                try:
                    rid = _normalize_rfc_id(fetch_rfc_message_id(thread_connection, anchor.gmail_message_id))
                except NeedsReauth:
                    raise
                except Exception:
                    rid = None
                if rid:
                    root.rfc_message_id = rid
        if rid and rid not in chain:
            chain.append(rid)

    # Prefer live Gmail thread Message-IDs so In-Reply-To / References match what Gmail expects.
    if thread_id and not thread_connection.is_demo:
        try:
            live = fetch_thread(thread_connection, thread_id)
            for item in live:
                rid = _normalize_rfc_id(item.get("rfc_message_id"))
                if rid and rid not in chain:
                    chain.append(rid)
        except NeedsReauth:
            raise
        except Exception:
            pass

    latest_inbound = (
        db.query(MessageReply)
        .filter(MessageReply.message_id == root.id, MessageReply.direction == "inbound")
        .order_by(MessageReply.occurred_at.desc().nullslast(), MessageReply.created_at.desc())
        .first()
    )
    in_reply_to = _normalize_rfc_id(latest_inbound.rfc_message_id if latest_inbound else None)
    if not in_reply_to and chain:
        in_reply_to = chain[-1]
    if in_reply_to and in_reply_to not in chain:
        chain.append(in_reply_to)
    references = " ".join(chain) if chain else None

    if message.parent_message_id and not thread_connection.is_demo and thread_id and not in_reply_to:
        raise PermanentSend(
            "no_thread",
            "Missing reply headers for this thread. Open the conversation to sync once, then send the reply again.",
        )

    if message.parent_message_id or thread_id:
        return thread_id, in_reply_to, references
    return None, None, None


def _send_recipient(db: Session, message: Message, recipient: MessageRecipient) -> None:
    connection = db.get(GmailConnection, message.gmail_connection_id) if message.gmail_connection_id else None
    if connection is None or connection.status != "connected":
        _fail(db, message, recipient, "unauthorized", "The Gmail connection is not available. Reconnect it and retry.")
        return
    record_event(
        db,
        workspace_id=message.workspace_id,
        message_id=message.id,
        message_recipient_id=recipient.id,
        event_type="message_send_started",
        source="system",
        details={"counts_toward_metric": 0},
    )
    others = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == message.id, MessageRecipient.id != recipient.id)
        .all()
    )
    cc = [item.email_snapshot for item in others if item.recipient_type == "cc"]
    bcc = [item.email_snapshot for item in others if item.recipient_type == "bcc"]
    sender = db.get(User, message.created_by)
    document = db.get(DocumentAsset, message.document_id) if message.document_id else None
    pdf_name, pdf_bytes = pdf_attachment(document, message.attach_pdf)
    if message.attach_pdf and not pdf_bytes:
        _fail(db, message, recipient, "pdf_missing", "The PDF could not be attached.", permanent=True)
        return
    contact = db.get(Contact, recipient.contact_id) if recipient.contact_id else None
    fields = _contact_fields(recipient, contact)
    subject = render_text(message.subject or "", fields)
    try:
        gmail_thread_id, in_reply_to, references = _thread_reply_headers(db, message, connection)
    except NeedsReauth:
        connection.status = "needs_reauth"
        _fail(
            db,
            message,
            recipient,
            "unauthorized",
            "Gmail needs to be reconnected before this message can send.",
            permanent=True,
        )
        return
    except PermanentSend as exc:
        _fail(db, message, recipient, exc.code, exc.message, permanent=True)
        return
    # Prefer the root mailbox for threaded replies.
    if message.parent_message_id:
        root = root_message(db, message)
        if root.gmail_connection_id and root.gmail_connection_id != connection.id:
            root_conn = db.get(GmailConnection, root.gmail_connection_id)
            if root_conn and root_conn.status == "connected":
                connection = root_conn
                message.gmail_connection_id = root_conn.id
                message.from_email = root_conn.google_account_email
    rfc_id = _normalize_rfc_id(message.rfc_message_id) or _make_rfc_message_id(connection.google_account_email)
    message.rfc_message_id = rfc_id
    if gmail_thread_id and not message.gmail_thread_id:
        message.gmail_thread_id = gmail_thread_id
    raw = build_mime(
        from_name=sender.display_name if sender else "",
        from_email=connection.google_account_email,
        to_emails=[recipient.email_snapshot],
        cc_emails=cc,
        bcc_emails=bcc,
        subject=subject,
        text=recipient.rendered_text or "",
        html=recipient.rendered_html or "<p></p>",
        pdf_filename=pdf_name,
        pdf_bytes=pdf_bytes,
        message_id=rfc_id,
        in_reply_to=in_reply_to,
        references=references,
    )
    recipient.attempt_count += 1
    try:
        provider_id, thread_id, is_demo = deliver(connection, raw, thread_id=gmail_thread_id)
    except NeedsReauth:
        connection.status = "needs_reauth"
        _fail(
            db,
            message,
            recipient,
            "unauthorized",
            "Gmail needs to be reconnected before this message can send.",
            permanent=True,
        )
        return
    except AmbiguousSend:
        recipient.send_status = "needs_review"
        recipient.error_code = "ambiguous"
        recipient.error_message = (
            "Gmail did not confirm whether this send was accepted. Retry only if you are sure it was not delivered."
        )
        record_event(
            db,
            workspace_id=message.workspace_id,
            message_id=message.id,
            message_recipient_id=recipient.id,
            event_type="message_send_failed",
            source="gmail_api",
            details={"error_code": "ambiguous", "counts_toward_metric": 0},
        )
        return
    except TransientSend as exc:
        if recipient.attempt_count >= 3:
            _fail(db, message, recipient, exc.code, exc.message)
        else:
            delay = [30, 120, 600][min(recipient.attempt_count - 1, 2)]
            recipient.send_status = "queued"
            recipient.next_attempt_at = utcnow() + timedelta(seconds=delay)
            recipient.error_code = exc.code
            recipient.error_message = exc.message
        return
    except PermanentSend as exc:
        _fail(db, message, recipient, exc.code, exc.message, permanent=True)
        return
    recipient.send_status = "sent"
    recipient.gmail_message_id = provider_id
    recipient.error_code = None
    recipient.error_message = None
    if thread_id:
        message.gmail_thread_id = thread_id
        root = root_message(db, message)
        if not root.gmail_thread_id:
            root.gmail_thread_id = thread_id
    # Persist the Message-ID Gmail actually stored so later replies thread correctly.
    if provider_id and not is_demo:
        try:
            actual_rfc = _normalize_rfc_id(fetch_rfc_message_id(connection, provider_id))
            if actual_rfc:
                message.rfc_message_id = actual_rfc
        except Exception:
            pass
    for item in others:
        if item.recipient_type in {"cc", "bcc"}:
            item.send_status = "sent"
            item.gmail_message_id = provider_id
    if recipient.contact_id:
        contact = db.get(Contact, recipient.contact_id)
        if contact is not None:
            contact.last_contacted_at = utcnow()
            # Activity never moves status backward from interview/replied/etc.
            if (contact.pipeline_status or "to_contact") in {"to_contact", "draft"}:
                contact.pipeline_status = "sent"
    if recipient.recipient_type == "to":
        schedule_follow_up(db, message)
    record_event(
        db,
        workspace_id=message.workspace_id,
        message_id=message.id,
        message_recipient_id=recipient.id,
        event_type="message_send_succeeded",
        source="gmail_api" if not is_demo else "system",
        details={"demo": is_demo, "counts_toward_metric": 0, "pdf_attached": bool(pdf_bytes)},
    )
    _log_sheet(db, message, recipient)


def _fail(
    db: Session,
    message: Message,
    recipient: MessageRecipient,
    code: str,
    message_text: str,
    permanent: bool = False,
) -> None:
    recipient.send_status = "failed"
    recipient.error_code = code
    recipient.error_message = message_text
    others = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == message.id, MessageRecipient.recipient_type.in_(["cc", "bcc"]))
        .all()
    )
    for item in others:
        item.send_status = "failed"
        item.error_code = code
        item.error_message = message_text
    record_event(
        db,
        workspace_id=message.workspace_id,
        message_id=message.id,
        message_recipient_id=recipient.id,
        event_type="message_send_failed",
        source="gmail_api",
        details={"error_code": code, "permanent": permanent, "counts_toward_metric": 0},
    )


def retry_message(db: Session, message: Message, actor: User, confirm_duplicate: bool) -> Message:
    recipients = (
        db.query(MessageRecipient)
        .filter(MessageRecipient.message_id == message.id, MessageRecipient.recipient_type == "to")
        .all()
    )
    needs_confirm = any(item.send_status == "needs_review" for item in recipients)
    if needs_confirm and not confirm_duplicate:
        raise AppError(
            409,
            "confirm_duplicate",
            "Gmail may already have accepted this send. Confirm only if you have checked that it was not delivered.",
        )
    queued = 0
    for recipient in recipients:
        if recipient.send_status == "sent":
            continue
        if recipient.send_status == "failed" and recipient.error_code in PERMANENT_CODES:
            continue
        if recipient.send_status not in {"failed", "needs_review"}:
            continue
        recipient.send_status = "queued"
        recipient.next_attempt_at = utcnow()
        queued += 1
    if queued == 0:
        raise AppError(400, "not_retryable", "There is no retryable recipient on this message.")
    message.send_status = "queued"
    audit(
        db,
        workspace_id=message.workspace_id,
        actor_user_id=actor.id,
        action="message_retried",
        target_type="message",
        target_id=message.id,
        details={"recipients": queued, "confirmed_duplicate_risk": confirm_duplicate},
    )
    db.commit()
    kick_sender()
    db.expire_all()
    db.refresh(message)
    return message


def revoke_tracking(db: Session, message: Message, actor: User) -> None:
    now = utcnow()
    recipient_ids = [
        row[0]
        for row in db.query(MessageRecipient.id).filter(MessageRecipient.message_id == message.id).all()
    ]
    if recipient_ids:
        db.query(TrackingLink).filter(
            TrackingLink.message_recipient_id.in_(recipient_ids), TrackingLink.revoked_at.is_(None)
        ).update({"revoked_at": now}, synchronize_session=False)
        db.query(OpenToken).filter(
            OpenToken.message_id == message.id, OpenToken.revoked_at.is_(None)
        ).update({"revoked_at": now}, synchronize_session=False)
        db.query(DocumentAccessToken).filter(
            DocumentAccessToken.message_recipient_id.in_(recipient_ids),
            DocumentAccessToken.revoked_at.is_(None),
        ).update({"revoked_at": now}, synchronize_session=False)
    record_event(
        db,
        workspace_id=message.workspace_id,
        message_id=message.id,
        event_type="tracking_link_revoked",
        source="system",
        details={"counts_toward_metric": 0},
    )
    audit(
        db,
        workspace_id=message.workspace_id,
        actor_user_id=actor.id,
        action="tracking_revoked",
        target_type="message",
        target_id=message.id,
    )
    db.commit()


def sends_today(db: Session, workspace_id: str) -> int:
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        db.query(MessageRecipient)
        .join(Message, Message.id == MessageRecipient.message_id)
        .filter(
            MessageRecipient.workspace_id == workspace_id,
            MessageRecipient.recipient_type == "to",
            Message.is_sample.is_(False),
            MessageRecipient.send_status.in_(["queued", "sending", "sent", "needs_review"]),
            MessageRecipient.updated_at >= start,
        )
        .count()
    )


def kick_sender() -> None:
    _drain()


def _drain() -> None:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        for _ in range(50):
            if not process_one(db):
                break
    except Exception:
        log.exception("sender_drain_failed")
        db.rollback()
    finally:
        db.close()


def start_worker() -> None:
    if get_settings().testing:
        return

    def loop() -> None:
        import time

        while True:
            try:
                _drain()
                _purge()
            except Exception:
                log.exception("worker_loop_failed")
            time.sleep(2)

    threading.Thread(target=loop, daemon=True).start()


def _purge() -> None:
    from app.core.database import SessionLocal
    from app.models import TrackingEvent

    db = SessionLocal()
    try:
        workspaces = db.query(Workspace).all()
        now = utcnow()
        for workspace in workspaces:
            cutoff = now - timedelta(days=workspace.retention_days)
            db.query(TrackingEvent).filter(
                TrackingEvent.workspace_id == workspace.id,
                TrackingEvent.occurred_at < cutoff,
            ).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()
