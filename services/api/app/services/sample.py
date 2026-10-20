from datetime import timedelta

from sqlalchemy.orm import Session

from app.core.security import encrypt_secret, hash_token, new_token
from app.models import (
    DocumentAccessToken,
    DocumentAsset,
    GmailConnection,
    Message,
    MessageRecipient,
    TrackingEvent,
    User,
    Workspace,
    utcnow,
)
from app.services.document_storage import delete_bytes, object_key, put_bytes
from app.services.events import audit


def load_sample(db: Session, workspace: Workspace, user: User) -> dict:
    clear_sample(db, workspace, commit=False)
    connection = (
        db.query(GmailConnection)
        .filter(
            GmailConnection.workspace_id == workspace.id,
            GmailConnection.status == "connected",
            GmailConnection.is_demo.is_(True),
        )
        .first()
    )
    if connection is None:
        connection = GmailConnection(
            workspace_id=workspace.id,
            connected_by=user.id,
            google_account_email=user.email,
            encrypted_refresh_token=encrypt_secret("demo"),
            granted_scopes=["demo"],
            status="connected",
            is_demo=True,
        )
        db.add(connection)
        db.flush()

    document_id = _sample_document(db, workspace, user)
    now = utcnow()
    raw_doc_token = new_token()
    viewer_url = None

    first = _message(
        db,
        workspace,
        user,
        connection,
        "Northwind — security questionnaire",
        "Aisha, the questionnaire is ready whenever you have a quiet hour.\n\nhttps://example.com/security",
        now - timedelta(hours=2),
        "sent",
        [("aisha@northwind.example", "Aisha Shah", "to")],
    )
    _event(db, first, "open_pixel_requested", "tracking_pixel", now - timedelta(hours=1, minutes=40), counts=1)
    _event(db, first, "tracked_link_requested", "redirect", now - timedelta(hours=1, minutes=12), counts=1)

    second = _message(
        db,
        workspace,
        user,
        connection,
        "Signed order form",
        "Leo — the order form is in the viewer. Page two has the start date.",
        now - timedelta(days=1),
        "sent",
        [("leo@brightpath.example", "Leo Martins", "to")],
        document_id=document_id,
    )
    db.add(
        DocumentAccessToken(
            workspace_id=workspace.id,
            document_id=document_id,
            message_recipient_id=second["recipients"][0].id,
            token_hash=hash_token(raw_doc_token),
            expires_at=now + timedelta(days=30),
        )
    )
    from app.core.config import get_settings

    from app.services.public_links import public_document_url

    viewer_url = public_document_url(raw_doc_token)
    second["recipients"][0].rendered_html = (
        f"<p>Leo — the order form is in the viewer.</p><p><a href=\"{viewer_url}\">View document</a></p>"
    )
    _event(
        db,
        second,
        "document_view_started",
        "document_viewer",
        now - timedelta(hours=20),
        counts=1,
        document_id=document_id,
    )
    _event(
        db,
        second,
        "document_page_viewed",
        "document_viewer",
        now - timedelta(hours=20) + timedelta(minutes=1),
        counts=1,
        document_id=document_id,
        details={"page": 1},
    )
    _event(
        db,
        second,
        "document_page_viewed",
        "document_viewer",
        now - timedelta(hours=20) + timedelta(minutes=3),
        counts=1,
        document_id=document_id,
        details={"page": 2},
    )

    _message(
        db,
        workspace,
        user,
        connection,
        "Onboarding plan for Harbor & Co",
        "Mina, sending the plan we walked through. No rush on a reply.",
        now - timedelta(days=3),
        "sent",
        [("mina@harbor.example", "Mina Park", "to")],
    )

    failed = _message(
        db,
        workspace,
        user,
        connection,
        "Invoice 1842 is ready",
        "Finance team — invoice 1842 is attached as a link in the live product. This sample failed so you can try a retry.",
        now - timedelta(days=1, hours=2),
        "failed",
        [("finance@northwind.example", "Northwind Finance", "to")],
    )
    failed["recipients"][0].send_status = "failed"
    failed["recipients"][0].error_code = "rate_limit"
    failed["recipients"][0].error_message = "Gmail is rate limiting this account. Wait before sending more."
    failed["message"].error_code = "rate_limit"
    failed["message"].error_message = failed["recipients"][0].error_message
    _event(
        db,
        failed,
        "message_send_failed",
        "gmail_api",
        now - timedelta(days=1, hours=2),
        counts=0,
        details={"error_code": "rate_limit"},
    )

    mixed = _message(
        db,
        workspace,
        user,
        connection,
        "Workshop follow-up",
        "Thank you both for the workshop. The notes are below.\n\n**Next step:** pick a date for the working session.",
        now - timedelta(hours=5),
        "sent",
        [
            ("priya@fieldnote.example", "Priya Raman", "to"),
            ("owen@fieldnote.example", "Owen Blake", "to"),
        ],
    )
    _event(db, mixed, "open_pixel_requested", "tracking_pixel", now - timedelta(hours=4), counts=1, recipient_index=0)

    audit(
        db,
        workspace_id=workspace.id,
        actor_user_id=user.id,
        action="sample_loaded",
        target_type="workspace",
        target_id=workspace.id,
    )
    db.commit()
    return {"loaded": True, "sample_viewer_url": viewer_url}


def clear_sample(db: Session, workspace: Workspace, commit: bool = True) -> None:
    sample_ids = [
        row[0]
        for row in db.query(Message.id).filter(Message.workspace_id == workspace.id, Message.is_sample.is_(True)).all()
    ]
    if sample_ids:
        db.query(TrackingEvent).filter(TrackingEvent.message_id.in_(sample_ids)).delete(synchronize_session=False)
        recipient_ids = [
            row[0]
            for row in db.query(MessageRecipient.id).filter(MessageRecipient.message_id.in_(sample_ids)).all()
        ]
        if recipient_ids:
            db.query(DocumentAccessToken).filter(DocumentAccessToken.message_recipient_id.in_(recipient_ids)).delete(
                synchronize_session=False
            )
            from app.models import OpenToken, TrackingLink

            db.query(TrackingLink).filter(TrackingLink.message_recipient_id.in_(recipient_ids)).delete(
                synchronize_session=False
            )
            db.query(OpenToken).filter(OpenToken.message_recipient_id.in_(recipient_ids)).delete(
                synchronize_session=False
            )
            db.query(MessageRecipient).filter(MessageRecipient.id.in_(recipient_ids)).delete(synchronize_session=False)
        db.query(Message).filter(Message.id.in_(sample_ids)).delete(synchronize_session=False)
    documents = (
        db.query(DocumentAsset)
        .filter(DocumentAsset.workspace_id == workspace.id, DocumentAsset.is_sample.is_(True))
        .all()
    )
    for document in documents:
        delete_bytes(document.storage_path)
        db.query(DocumentAccessToken).filter(DocumentAccessToken.document_id == document.id).delete(
            synchronize_session=False
        )
        db.query(TrackingEvent).filter(TrackingEvent.document_id == document.id).delete(synchronize_session=False)
        db.delete(document)
    if commit:
        db.commit()


def _sample_document(db: Session, workspace: Workspace, user: User) -> str:
    body = (
        "Order form\n\n"
        "Brightpath Studio\n"
        "Start date: 3 November\n"
        "Term: 12 months\n\n"
        "This is sample content inside MailInsider. "
        "Opening it records a document view for the sender.\n"
    ).encode()
    file_id = new_token()[:16]
    relative = object_key(workspace.id, file_id)
    put_bytes(relative, body, "text/plain")
    document = DocumentAsset(
        workspace_id=workspace.id,
        uploaded_by=user.id,
        storage_path=relative,
        filename="Brightpath-order-form.txt",
        content_type="text/plain",
        size_bytes=len(body),
        is_sample=True,
    )
    db.add(document)
    db.flush()
    return document.id


def _message(
    db: Session,
    workspace: Workspace,
    user: User,
    connection: GmailConnection,
    subject: str,
    body: str,
    when,
    status: str,
    people: list[tuple[str, str, str]],
    document_id: str | None = None,
) -> dict:
    message = Message(
        workspace_id=workspace.id,
        created_by=user.id,
        gmail_connection_id=connection.id,
        from_email=connection.google_account_email,
        subject=subject,
        body_format="plain",
        body_text=body,
        send_status=status,
        open_tracking=True,
        link_tracking=True,
        is_sample=True,
        document_id=document_id,
        sent_at=when if status == "sent" else None,
        created_at=when,
        updated_at=when,
    )
    db.add(message)
    db.flush()
    recipients = []
    for email, name, kind in people:
        recipient = MessageRecipient(
            workspace_id=workspace.id,
            message_id=message.id,
            email_snapshot=email,
            display_name_snapshot=name,
            recipient_type=kind,
            send_status="sent" if status == "sent" else status,
            gmail_message_id=f"demo-sample-{message.id[:8]}" if status == "sent" else None,
            rendered_html=f"<p>{body}</p>",
            rendered_text=body,
            created_at=when,
            updated_at=when,
        )
        db.add(recipient)
        recipients.append(recipient)
    db.flush()
    if status == "sent":
        _event_on(db, message, recipients[0], "message_send_succeeded", "system", when, 0, {"demo": True})
    return {"message": message, "recipients": recipients}


def _event(db, bundle, event_type, source, when, counts: int, recipient_index: int = 0, document_id=None, details=None):
    payload = {"counts_toward_metric": counts, "possible_automated": 0}
    if details:
        payload.update(details)
    _event_on(db, bundle["message"], bundle["recipients"][recipient_index], event_type, source, when, counts, payload)


def _event_on(db, message, recipient, event_type, source, when, counts, details):
    payload = dict(details)
    payload.setdefault("counts_toward_metric", counts)
    payload.setdefault("possible_automated", 0)
    db.add(
        TrackingEvent(
            workspace_id=message.workspace_id,
            message_id=message.id,
            message_recipient_id=recipient.id,
            document_id=message.document_id if event_type.startswith("document_") else None,
            event_type=event_type,
            source=source,
            occurred_at=when,
            received_at=when,
            details=payload,
        )
    )
