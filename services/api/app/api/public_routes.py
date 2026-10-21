import time

from urllib.parse import urlparse

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.core.limiter import limiter
from app.core.security import hash_token
from app.models import (
    ContactInquiry,
    DocumentAccessToken,
    DocumentAsset,
    MessageRecipient,
    OpenToken,
    TrackingLink,
    UnsubscribeToken,
    WaitlistSignup,
    as_utc,
    utcnow,
)
from app.schemas import ContactInquiryIn, PublicEventIn, WaitlistIn
from app.services.document_storage import get_bytes
from app.services.events import maybe_infer_open, record_event, record_open_pixel_hit
from app.services.messaging import add_suppression
from app.services.render import is_safe_http_url

router = APIRouter(tags=["public"])

GIF = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!"
    b"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)
UNAVAILABLE = (
    "<!doctype html><html><head><meta charset='utf-8'><title>Link unavailable</title></head>"
    "<body style='font-family:sans-serif;padding:48px;color:#1a1714;background:#f3efe6'>"
    "<p>This link is unavailable.</p></body></html>"
)


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _gif() -> Response:
    return Response(
        content=GIF,
        media_type="image/gif",
        headers={"Cache-Control": "no-store, private", "X-Robots-Tag": "noindex, nofollow"},
    )


def _unavailable() -> HTMLResponse:
    return HTMLResponse(
        UNAVAILABLE,
        status_code=404,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex"},
    )


@router.post("/api/v1/public/contact")
def public_contact(payload: ContactInquiryIn, request: Request):
    from app.errors import AppError

    if not limiter.allow(f"contact:{_client(request)}", 8, 3600):
        raise AppError(429, "rate_limited", "Too many messages. Try again later.")
    # Honeypot: bots fill "website"; humans leave it blank.
    if (payload.website or "").strip():
        return {"ok": True}
    email = payload.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise AppError(422, "invalid_request", "Enter a valid email address.")
    db = SessionLocal()
    try:
        db.add(
            ContactInquiry(
                name=payload.name.strip(),
                email=email,
                subject=payload.subject.strip(),
                message=payload.message.strip(),
            )
        )
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.post("/api/v1/public/waitlist")
def public_waitlist(payload: WaitlistIn, request: Request):
    from app.errors import AppError

    if not limiter.allow(f"waitlist:{_client(request)}", 8, 3600):
        raise AppError(429, "rate_limited", "Too many waitlist attempts. Try again later.")
    if (payload.website or "").strip():
        return {"ok": True}
    email = payload.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise AppError(422, "invalid_request", "Enter a valid work or company email.")
    company = (payload.company_name or "").strip() or None
    db = SessionLocal()
    try:
        existing = db.query(WaitlistSignup).filter(WaitlistSignup.email == email).one_or_none()
        if existing is not None:
            existing.name = payload.name.strip()
            existing.company_name = company
            existing.monthly_sends = payload.monthly_sends
            existing.willing_to_pay = payload.willing_to_pay.strip()
        else:
            db.add(
                WaitlistSignup(
                    name=payload.name.strip(),
                    company_name=company,
                    email=email,
                    monthly_sends=payload.monthly_sends,
                    willing_to_pay=payload.willing_to_pay.strip(),
                )
            )
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.get("/t/open/{token_with_suffix}")
def open_pixel(token_with_suffix: str, request: Request):
    if not limiter.allow(f"pixel:{_client(request)}", 120, 60):
        return _gif()
    token = token_with_suffix[:-4] if token_with_suffix.endswith(".gif") else token_with_suffix
    db = SessionLocal()
    try:
        token_hash = hash_token(token)
        row = db.query(OpenToken).filter(OpenToken.token_hash == token_hash).one_or_none()
        if row is None or row.revoked_at is not None:
            return _gif()
        # Pixel load → API hit → DB row (always stored; counted only when genuine).
        record_open_pixel_hit(
            db,
            workspace_id=row.workspace_id,
            message_id=row.message_id,
            message_recipient_id=row.message_recipient_id,
            token_hash=token_hash,
            user_agent=request.headers.get("user-agent"),
            client_ip=_client(request),
            method=request.method,
        )
        db.commit()
    finally:
        db.close()
    return _gif()


@router.get("/t/click/{token}")
def click(token: str, request: Request):
    if not limiter.allow(f"click:{_client(request)}", 60, 60):
        return _unavailable()
    db = SessionLocal()
    try:
        row = db.query(TrackingLink).filter(TrackingLink.token_hash == hash_token(token)).one_or_none()
        if row is None or row.revoked_at is not None or not is_safe_http_url(row.destination_url):
            return _unavailable()
        recipient = db.get(MessageRecipient, row.message_recipient_id)
        message_id = recipient.message_id if recipient else None
        host = urlparse(row.destination_url).hostname or ""
        record_event(
            db,
            workspace_id=row.workspace_id,
            message_id=message_id,
            message_recipient_id=row.message_recipient_id,
            event_type="tracked_link_requested",
            source="redirect",
            burst=True,
            details={
                "counts_toward_metric": 1,
                "destination_host": host,
                "destination_url": row.destination_url,
                "confidence": "observed",
            },
        )
        maybe_infer_open(
            db,
            workspace_id=row.workspace_id,
            message_id=message_id,
            message_recipient_id=row.message_recipient_id,
            inferred_from="tracked_link_requested",
        )
        destination = row.destination_url
        db.commit()
    finally:
        db.close()
    response = RedirectResponse(destination, status_code=302)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


@router.get("/d/{token}")
def document_shortcut(token: str):
    from app.services.public_links import public_document_url

    # Prefer the public edge-function PDF URL so phones / other devices never hit localhost.
    url = public_document_url(token)
    response = RedirectResponse(url, status_code=302)
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/t/unsubscribe/{token}")
def unsubscribe(token: str, request: Request):
    if not limiter.allow(f"unsub:{_client(request)}", 30, 60):
        return HTMLResponse(
            "<!doctype html><html><body><p>Too many requests. Try again shortly.</p></body></html>",
            status_code=429,
        )
    db = SessionLocal()
    try:
        row = db.query(UnsubscribeToken).filter(UnsubscribeToken.token_hash == hash_token(token)).one_or_none()
        if row is None:
            return _unavailable()
        if row.used_at is None:
            add_suppression(
                db,
                workspace_id=row.workspace_id,
                email=row.email,
                reason="unsubscribe",
                source="recipient_link",
                message_id=None,
            )
            row.used_at = utcnow()
            recipient = db.get(MessageRecipient, row.message_recipient_id)
            record_event(
                db,
                workspace_id=row.workspace_id,
                message_id=recipient.message_id if recipient else None,
                message_recipient_id=row.message_recipient_id,
                event_type="unsubscribe",
                source="unsubscribe_link",
                details={"counts_toward_metric": 0},
            )
            db.commit()
        body = (
            "<!doctype html><html><head><meta charset='utf-8'><title>Unsubscribed</title></head>"
            "<body style='font-family:sans-serif;padding:48px;color:#1a1714;background:#f3efe6'>"
            "<h1>You are unsubscribed</h1>"
            "<p>You will not receive further marketing messages from this workspace.</p>"
            "</body></html>"
        )
        return HTMLResponse(body, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})
    finally:
        db.close()


def _access(db: Session, token: str) -> tuple[DocumentAccessToken | None, DocumentAsset | None, str]:
    row = db.query(DocumentAccessToken).filter(DocumentAccessToken.token_hash == hash_token(token)).one_or_none()
    if row is None:
        return None, None, "unknown"
    if row.revoked_at is not None:
        return row, None, "revoked"
    if row.expires_at is not None and as_utc(row.expires_at) < utcnow():
        return row, None, "expired"
    document = db.get(DocumentAsset, row.document_id)
    if document is None:
        return row, None, "missing"
    return row, document, "ok"


@router.get("/api/v1/public/documents/{token}")
def public_meta(token: str):
    db = SessionLocal()
    try:
        row, document, state = _access(db, token)
        if state in {"revoked", "expired"} and row is not None:
            record_event(
                db,
                workspace_id=row.workspace_id,
                message_id=_message_id(db, row),
                message_recipient_id=row.message_recipient_id,
                document_id=row.document_id,
                event_type="document_access_denied",
                source="document_viewer",
                details={"counts_toward_metric": 0, "reason": state},
                idempotency_key=f"denied:{row.id}:{state}:{int(time.time() // 3600)}",
            )
            db.commit()
        if state != "ok" or document is None:
            return _unavailable_json()
        return {
            "filename": document.filename,
            "content_type": document.content_type,
            "size_bytes": document.size_bytes,
            "disclosure": "The sender can see that this document was opened and which pages were displayed.",
        }
    finally:
        db.close()


@router.get("/api/v1/public/documents/{token}/file")
def public_file(token: str, request: Request):
    if not limiter.allow(f"doc:{_client(request)}", 60, 60):
        return _unavailable_json()
    db = SessionLocal()
    try:
        row, document, state = _access(db, token)
        if state != "ok" or document is None or row is None:
            if row is not None and state in {"revoked", "expired"}:
                record_event(
                    db,
                    workspace_id=row.workspace_id,
                    document_id=row.document_id,
                    message_recipient_id=row.message_recipient_id,
                    message_id=_message_id(db, row),
                    event_type="document_access_denied",
                    source="document_viewer",
                    details={"counts_toward_metric": 0, "reason": state},
                    idempotency_key=f"denied:{row.id}:{state}:{int(time.time() // 3600)}",
                )
                db.commit()
            return _unavailable_json()
        data = get_bytes(document.storage_path)
        if data is None:
            return _unavailable_json()
        message_id = _message_id(db, row)
        record_event(
            db,
            workspace_id=row.workspace_id,
            message_id=message_id,
            message_recipient_id=row.message_recipient_id,
            document_id=document.id,
            event_type="document_access_granted",
            source="document_viewer",
            details={"counts_toward_metric": 0},
            idempotency_key=f"access:{row.id}:{int(time.time() // 1800)}",
        )
        maybe_infer_open(
            db,
            workspace_id=row.workspace_id,
            message_id=message_id,
            message_recipient_id=row.message_recipient_id,
            inferred_from="document_access_granted",
        )
        db.commit()
        disposition = "attachment" if request.query_params.get("download") == "1" else "inline"
        safe_name = document.filename.replace('"', "")
        return Response(
            content=data,
            media_type=document.content_type,
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": f'{disposition}; filename="{safe_name}"',
            },
        )
    finally:
        db.close()


@router.post("/api/v1/public/documents/{token}/events")
def public_event(token: str, payload: PublicEventIn, request: Request):
    if not limiter.allow(f"docevent:{_client(request)}", 90, 60):
        return _unavailable_json()
    if payload.type == "document_page_viewed" and (payload.page is None or payload.page < 1 or payload.page > 5000):
        return _unavailable_json()
    db = SessionLocal()
    try:
        row, document, state = _access(db, token)
        if state != "ok" or document is None or row is None:
            return _unavailable_json()
        day = utcnow().date().isoformat()
        if payload.type == "document_page_viewed":
            key = f"page:{row.id}:{payload.page}:{day}"
            details = {"page": payload.page, "counts_toward_metric": 1}
        elif payload.type == "document_view_started":
            key = f"view:{row.id}:{day}"
            details = {"counts_toward_metric": 1}
        else:
            key = f"download:{row.id}:{int(time.time() // 30)}"
            details = {"counts_toward_metric": 1}
        message_id = _message_id(db, row)
        record_event(
            db,
            workspace_id=row.workspace_id,
            message_id=message_id,
            message_recipient_id=row.message_recipient_id,
            document_id=document.id,
            event_type=payload.type,
            source="document_viewer",
            details=details,
            idempotency_key=key,
        )
        maybe_infer_open(
            db,
            workspace_id=row.workspace_id,
            message_id=message_id,
            message_recipient_id=row.message_recipient_id,
            inferred_from=payload.type,
        )
        db.commit()
        return {"recorded": True}
    finally:
        db.close()


def _message_id(db: Session, row: DocumentAccessToken) -> str | None:
    if not row.message_recipient_id:
        return None
    recipient = db.get(MessageRecipient, row.message_recipient_id)
    return recipient.message_id if recipient else None


def _unavailable_json():
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=404,
        content={"error": {"code": "unavailable", "message": "This document link is unavailable."}},
        headers={"Cache-Control": "no-store"},
    )
