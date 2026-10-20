"""AI Parameters & Regulations (P&R) + knowledge docs for RAG."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field

from app.api.deps import Ctx, get_ctx
from app.core.config import get_settings
from app.errors import AppError
from app.models import AiKnowledgeDoc, utcnow
from app.services.pdf_text import extract_pdf_text
from app.services.rag import (
    format_rag_for_prompt,
    get_or_create_profile,
    index_document,
    profile_payload,
    retrieve_context,
)

router = APIRouter(prefix="/ai/pr", tags=["ai-pr"])

# The three career PDFs users typically upload for RAG grounding.
PDF_KINDS = {
    "linkedin": "LinkedIn profile",
    "resume": "Resume",
    "chatgpt_summary": "ChatGPT career summary",
}


class ProfileIn(BaseModel):
    display_name: str = Field(default="", max_length=160)
    headline: str = Field(default="", max_length=240)
    summary: str = Field(default="", max_length=8000)
    skills: str = Field(default="", max_length=4000)
    looking_for: str = Field(default="", max_length=4000)
    target_roles: str = Field(default="", max_length=2000)
    target_companies: str = Field(default="", max_length=2000)
    location_pref: str = Field(default="", max_length=200)
    regulations: str = Field(default="", max_length=8000)
    tone_rules: str = Field(default="", max_length=4000)
    do_not_claim: str = Field(default="", max_length=4000)
    email_signature: str = Field(default="", max_length=2000)


class DocIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content_text: str = Field(..., min_length=1, max_length=200_000)


class DocPatchIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    content_text: str | None = Field(default=None, max_length=200_000)


class RetrieveIn(BaseModel):
    query: str = Field(default="", max_length=2000)
    limit: int = Field(default=5, ge=1, le=8)
    prefer_sources: list[str] | None = Field(default=None, max_length=6)
    match_compose: bool = Field(
        default=True,
        description="When true, application-like queries prefer resume/LinkedIn/ChatGPT sources like Compose.",
    )


def _doc_payload(doc: AiKnowledgeDoc) -> dict:
    return {
        "id": doc.id,
        "title": doc.title,
        "content_text": doc.content_text,
        "source": doc.source,
        "chunk_count": doc.chunk_count,
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
    }


@router.get("")
def get_pr(ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    profile = get_or_create_profile(ctx.db, ctx.workspace.id)
    docs = (
        ctx.db.query(AiKnowledgeDoc)
        .filter(AiKnowledgeDoc.workspace_id == ctx.workspace.id)
        .order_by(AiKnowledgeDoc.updated_at.desc())
        .all()
    )
    return {
        "profile": profile_payload(profile),
        "documents": [_doc_payload(doc) for doc in docs],
        "pdf_kinds": [
            {"id": key, "label": label}
            for key, label in PDF_KINDS.items()
        ],
    }


@router.put("/profile")
def put_profile(payload: ProfileIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = get_or_create_profile(ctx.db, ctx.workspace.id)
    for field, value in payload.model_dump().items():
        setattr(row, field, (value or "").strip())
    row.updated_at = utcnow()
    ctx.db.commit()
    ctx.db.refresh(row)
    return {"profile": profile_payload(row)}


@router.post("/documents")
async def create_document(payload: DocIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    doc = AiKnowledgeDoc(
        workspace_id=ctx.workspace.id,
        title=payload.title.strip(),
        content_text=payload.content_text.strip(),
        source="manual",
        created_by=ctx.user.id,
    )
    ctx.db.add(doc)
    ctx.db.commit()
    ctx.db.refresh(doc)
    chunks = await index_document(ctx.db, doc)
    ctx.db.refresh(doc)
    return {"document": _doc_payload(doc), "chunks_indexed": chunks}


@router.post("/documents/pdf")
async def upload_pdf(
    ctx: Ctx = Depends(get_ctx),
    kind: str = Form("resume"),
    file: UploadFile = File(...),
):
    """Upload LinkedIn / resume / ChatGPT-summary PDF; extract text and index for RAG.

    Replaces any existing doc with the same kind so you keep one of each.
    """
    ctx.require("member")
    kind_key = (kind or "resume").strip().lower()
    if kind_key not in PDF_KINDS:
        raise AppError(400, "invalid_kind", "Use kind=linkedin, resume, or chatgpt_summary.")

    filename = (file.filename or "document.pdf").strip()
    if not filename.lower().endswith(".pdf"):
        raise AppError(400, "pdf_required", "Upload a PDF file.")

    data = await file.read()
    max_bytes = get_settings().max_upload_bytes
    if len(data) > max_bytes:
        raise AppError(400, "too_large", f"PDF must be under {max_bytes // (1024 * 1024)} MB.")
    if not data:
        raise AppError(400, "empty_file", "The uploaded file is empty.")

    text = extract_pdf_text(data, filename=filename)
    title = f"{PDF_KINDS[kind_key]} ({filename})"

    existing = (
        ctx.db.query(AiKnowledgeDoc)
        .filter(AiKnowledgeDoc.workspace_id == ctx.workspace.id, AiKnowledgeDoc.source == kind_key)
        .all()
    )
    for row in existing:
        ctx.db.delete(row)
    ctx.db.commit()

    doc = AiKnowledgeDoc(
        workspace_id=ctx.workspace.id,
        title=title[:200],
        content_text=text,
        source=kind_key,
        created_by=ctx.user.id,
    )
    ctx.db.add(doc)
    ctx.db.commit()
    ctx.db.refresh(doc)
    chunks = await index_document(ctx.db, doc)
    ctx.db.refresh(doc)
    return {
        "document": _doc_payload(doc),
        "chunks_indexed": chunks,
        "chars_extracted": len(text),
        "kind": kind_key,
        "replaced": len(existing),
    }


@router.patch("/documents/{document_id}")
async def patch_document(document_id: str, payload: DocPatchIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    doc = (
        ctx.db.query(AiKnowledgeDoc)
        .filter(AiKnowledgeDoc.id == document_id, AiKnowledgeDoc.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if not doc:
        raise AppError(404, "not_found", "Knowledge document not found.")
    if payload.title is not None:
        doc.title = payload.title.strip() or doc.title
    if payload.content_text is not None:
        doc.content_text = payload.content_text.strip()
    doc.updated_at = utcnow()
    ctx.db.commit()
    chunks = await index_document(ctx.db, doc)
    ctx.db.refresh(doc)
    return {"document": _doc_payload(doc), "chunks_indexed": chunks}


@router.delete("/documents/{document_id}")
def delete_document(document_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    doc = (
        ctx.db.query(AiKnowledgeDoc)
        .filter(AiKnowledgeDoc.id == document_id, AiKnowledgeDoc.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if not doc:
        raise AppError(404, "not_found", "Knowledge document not found.")
    ctx.db.delete(doc)
    ctx.db.commit()
    return {"ok": True}


@router.post("/retrieve")
async def retrieve(payload: RetrieveIn, ctx: Ctx = Depends(get_ctx)):
    """Debug / preview RAG context used by compose."""
    ctx.require("member")
    # None = auto (job-like → prefer career PDFs). [] = no source preference.
    if payload.prefer_sources is not None:
        prefer: list[str] | None = payload.prefer_sources
    elif payload.match_compose:
        prefer = None
    else:
        prefer = []
    context = await retrieve_context(
        ctx.db,
        ctx.workspace.id,
        query=payload.query,
        limit=payload.limit,
        prefer_sources=prefer,
    )
    return {
        **context,
        "prompt_block": format_rag_for_prompt(context),
    }
