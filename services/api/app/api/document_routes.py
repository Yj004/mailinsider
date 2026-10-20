import re
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, File, UploadFile

from app.api.deps import Ctx, get_ctx
from app.core.config import get_settings
from app.core.security import hash_token, new_token
from app.errors import AppError
from app.models import DocumentAccessToken, DocumentAsset, MessageRecipient, TrackingEvent, as_utc, utcnow
from app.schemas import LinkIn, RevokeIn
from app.services.document_storage import object_key, put_bytes
from app.services.events import audit
from app.services.signals import iso

router = APIRouter(prefix="/documents", tags=["documents"])

EXTENSIONS = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain",
}


def _safe_name(filename: str) -> str:
    base = Path(filename or "document").name
    cleaned = re.sub(r"[^A-Za-z0-9._ -]", "", base).strip(" .")[:180]
    return cleaned or "document"


def _matches(data: bytes, content_type: str) -> bool:
    if content_type == "application/pdf":
        return data.startswith(b"%PDF")
    if content_type == "image/png":
        return data.startswith(b"\x89PNG")
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return len(data) > 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    if content_type == "text/plain":
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return False
        lowered = data[:200].lower()
        return b"<html" not in lowered and b"<script" not in lowered
    return False


def _payload(document: DocumentAsset, links: list[DocumentAccessToken], recipients: dict[str, str]) -> dict:
    return {
        "id": document.id,
        "filename": document.filename,
        "content_type": document.content_type,
        "size_bytes": document.size_bytes,
        "is_sample": document.is_sample,
        "created_at": iso(document.created_at),
        "links": [
            {
                "id": link.id,
                "expires_at": iso(link.expires_at),
                "revoked_at": iso(link.revoked_at),
                "created_at": iso(link.created_at),
                "recipient_email": recipients.get(link.message_recipient_id or ""),
                "active": link.revoked_at is None and (link.expires_at is None or as_utc(link.expires_at) > utcnow()),
            }
            for link in links
        ],
    }


def _owned(ctx: Ctx, document_id: str) -> DocumentAsset:
    document = (
        ctx.db.query(DocumentAsset)
        .filter(DocumentAsset.id == document_id, DocumentAsset.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if document is None:
        raise AppError(404, "not_found", "That document is not in this workspace.")
    return document


@router.post("")
async def upload_document(file: UploadFile = File(...), ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    filename = _safe_name(file.filename or "document")
    extension = Path(filename).suffix.lower()
    content_type = EXTENSIONS.get(extension)
    if content_type is None:
        raise AppError(400, "unsupported_file", "Upload a PDF, PNG, JPEG, WebP, or text file.")
    data = await file.read()
    if len(data) == 0:
        raise AppError(400, "empty_file", "That file is empty.")
    if len(data) > get_settings().max_upload_bytes:
        raise AppError(413, "file_too_large", "Files must be 15 MB or smaller.")
    if not _matches(data, content_type):
        raise AppError(400, "file_mismatch", "The file contents do not match its extension.")
    stored = f"{new_token()[:20]}{extension}"
    relative = object_key(ctx.workspace.id, stored)
    put_bytes(relative, data, content_type)
    document = DocumentAsset(
        workspace_id=ctx.workspace.id,
        uploaded_by=ctx.user.id,
        storage_path=relative,
        filename=filename,
        content_type=content_type,
        size_bytes=len(data),
    )
    ctx.db.add(document)
    ctx.db.flush()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="document_uploaded",
        target_type="document",
        target_id=document.id,
        details={"filename": filename, "size_bytes": len(data)},
    )
    ctx.db.commit()
    return _payload(document, [], {})


@router.get("")
def list_documents(ctx: Ctx = Depends(get_ctx)):
    documents = (
        ctx.db.query(DocumentAsset)
        .filter(DocumentAsset.workspace_id == ctx.workspace.id)
        .order_by(DocumentAsset.created_at.desc())
        .all()
    )
    ids = [item.id for item in documents]
    links = (
        ctx.db.query(DocumentAccessToken).filter(DocumentAccessToken.document_id.in_(ids)).all() if ids else []
    )
    recipient_ids = [link.message_recipient_id for link in links if link.message_recipient_id]
    recipients = {}
    if recipient_ids:
        recipients = {
            row.id: row.email_snapshot
            for row in ctx.db.query(MessageRecipient).filter(MessageRecipient.id.in_(recipient_ids)).all()
        }
    return {
        "documents": [
            _payload(document, [link for link in links if link.document_id == document.id], recipients)
            for document in documents
        ]
    }


@router.get("/{document_id}")
def get_document(document_id: str, ctx: Ctx = Depends(get_ctx)):
    document = _owned(ctx, document_id)
    links = ctx.db.query(DocumentAccessToken).filter(DocumentAccessToken.document_id == document.id).all()
    recipient_ids = [link.message_recipient_id for link in links if link.message_recipient_id]
    recipients = {}
    if recipient_ids:
        recipients = {
            row.id: row.email_snapshot
            for row in ctx.db.query(MessageRecipient).filter(MessageRecipient.id.in_(recipient_ids)).all()
        }
    return _payload(document, links, recipients)


@router.post("/{document_id}/links")
def create_link(document_id: str, payload: LinkIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    document = _owned(ctx, document_id)
    if payload.message_recipient_id:
        recipient = (
            ctx.db.query(MessageRecipient)
            .filter(
                MessageRecipient.id == payload.message_recipient_id,
                MessageRecipient.workspace_id == ctx.workspace.id,
            )
            .one_or_none()
        )
        if recipient is None:
            raise AppError(404, "not_found", "That recipient is not in this workspace.")
    raw = new_token()
    expires = utcnow() + timedelta(days=payload.expires_in_days) if payload.expires_in_days else None
    link = DocumentAccessToken(
        workspace_id=ctx.workspace.id,
        document_id=document.id,
        message_recipient_id=payload.message_recipient_id,
        token_hash=hash_token(raw),
        expires_at=expires,
    )
    ctx.db.add(link)
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="document_link_created",
        target_type="document",
        target_id=document.id,
    )
    ctx.db.commit()
    from app.services.public_links import public_document_url

    url = public_document_url(raw)
    return {
        "url": url,
        "expires_at": iso(expires),
        "notice": "Copy this link now. It cannot be shown again. You can revoke it at any time.",
    }


@router.post("/{document_id}/revoke")
def revoke_links(document_id: str, payload: RevokeIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    document = _owned(ctx, document_id)
    query = ctx.db.query(DocumentAccessToken).filter(
        DocumentAccessToken.document_id == document.id,
        DocumentAccessToken.revoked_at.is_(None),
    )
    if payload.token_id:
        query = query.filter(DocumentAccessToken.id == payload.token_id)
    updated = query.update({"revoked_at": utcnow()}, synchronize_session=False)
    if payload.token_id and updated == 0:
        raise AppError(404, "not_found", "That link is not active.")
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="document_revoked",
        target_type="document",
        target_id=document.id,
        details={"links": updated},
    )
    ctx.db.commit()
    return get_document(document.id, ctx)


@router.get("/{document_id}/events")
def document_events(document_id: str, ctx: Ctx = Depends(get_ctx)):
    document = _owned(ctx, document_id)
    events = (
        ctx.db.query(TrackingEvent)
        .filter(TrackingEvent.document_id == document.id, TrackingEvent.workspace_id == ctx.workspace.id)
        .order_by(TrackingEvent.occurred_at.asc())
        .limit(300)
        .all()
    )
    return {
        "events": [
            {
                "id": event.id,
                "event_type": event.event_type,
                "source": event.source,
                "occurred_at": iso(event.occurred_at),
                "metadata": {"page": (event.details or {}).get("page")},
            }
            for event in events
        ]
    }
