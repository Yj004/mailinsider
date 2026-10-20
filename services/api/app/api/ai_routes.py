from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.api.deps import Ctx, get_ctx
from app.core.limiter import limiter
from app.errors import AppError
from app.models import Contact, GmailConnection
from app.services.ai_provider import provider_status
from app.services.deliverability import full_analysis
from app.services.email_ai import TONES, LENGTHS, generate_email

router = APIRouter(prefix="/ai", tags=["ai"])


class DeliverabilityIn(BaseModel):
    subject: str = ""
    body_text: str = ""
    goal: str = Field(default="", max_length=400)
    recipient_hint: str = Field(default="", max_length=400)
    from_email: str | None = None
    gmail_connection_id: str | None = None
    has_attachment: bool = False
    attachment_name: str | None = None


class ComposeAiIn(BaseModel):
    action: str = "write"
    instruction: str = Field(default="", max_length=2000)
    refine_instruction: str = Field(default="", max_length=800)
    subject: str = Field(default="", max_length=300)
    body_text: str = Field(default="", max_length=20000)
    tone: str = "professional"
    length: str = "balanced"
    recipient_email: str | None = None
    thread_snippet: str = Field(default="", max_length=4000)
    goal: str = Field(default="", max_length=400)


def _client(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _resolve_from_email(ctx: Ctx, payload: DeliverabilityIn) -> str | None:
    if payload.from_email:
        return payload.from_email.strip().lower()
    if payload.gmail_connection_id:
        row = (
            ctx.db.query(GmailConnection)
            .filter(
                GmailConnection.id == payload.gmail_connection_id,
                GmailConnection.workspace_id == ctx.workspace.id,
            )
            .one_or_none()
        )
        if row:
            return (row.google_account_email or "").lower() or None
    row = (
        ctx.db.query(GmailConnection)
        .filter(GmailConnection.workspace_id == ctx.workspace.id, GmailConnection.status == "connected")
        .order_by(GmailConnection.updated_at.desc())
        .first()
    )
    return (row.google_account_email or "").lower() if row else None


def _contact_payload(ctx: Ctx, email: str | None) -> dict:
    if not email or "@" not in email:
        return {}
    cleaned = email.strip().lower()
    row = (
        ctx.db.query(Contact)
        .filter(Contact.workspace_id == ctx.workspace.id, Contact.email == cleaned)
        .one_or_none()
    )
    if not row:
        return {"email": cleaned}
    return {
        "email": row.email,
        "display_name": row.display_name,
        "company": row.company,
        "job_title": row.job_title,
        "target_role": row.target_role,
    }


@router.get("/status")
def ai_status(ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    status = provider_status()
    return {
        **status,
        "tones": sorted(TONES),
        "lengths": sorted(LENGTHS),
        "actions": [
            "write",
            "improve",
            "tone",
            "shorten",
            "subject",
            "personalize",
            "reply",
            "refine",
            "grammar",
            "deliverability",
        ],
    }


@router.post("/deliverability/analyze")
async def analyze_email(payload: DeliverabilityIn, request: Request, ctx: Ctx = Depends(get_ctx)):
    """Content spam-risk + optional SPF/DMARC lookups. Does not send."""
    ctx.require("member")
    if not limiter.allow(f"ai-analyze:{ctx.user.id}:{_client(request)}", 40, 60):
        raise AppError(429, "rate_limited", "Too many analysis requests. Wait a minute.")
    from_email = _resolve_from_email(ctx, payload)
    return await full_analysis(
        subject=payload.subject,
        body=payload.body_text,
        from_email=from_email,
        has_attachment=payload.has_attachment,
        attachment_name=payload.attachment_name,
    )


@router.post("/deliverability/improve")
async def improve_email(payload: DeliverabilityIn, request: Request, ctx: Ctx = Depends(get_ctx)):
    """Rewrite for lower content spam risk."""
    ctx.require("member")
    if not limiter.allow(f"ai-improve:{ctx.user.id}:{_client(request)}", 20, 60):
        raise AppError(429, "rate_limited", "Too many AI requests. Wait a minute.")
    return await generate_email(
        action="deliverability",
        instruction=payload.goal,
        subject=payload.subject,
        body_text=payload.body_text,
        recipient={"email": payload.recipient_hint} if payload.recipient_hint else {},
        db=ctx.db,
        workspace_id=ctx.workspace.id,
    )


@router.post("/compose")
async def compose_ai(payload: ComposeAiIn, request: Request, ctx: Ctx = Depends(get_ctx)):
    """Unified AI compose actions. Never sends — returns draft fields only."""
    ctx.require("member")
    if not limiter.allow(f"ai-compose:{ctx.user.id}:{_client(request)}", 25, 60):
        raise AppError(429, "rate_limited", "Too many AI requests. Wait a minute.")
    recipient = _contact_payload(ctx, payload.recipient_email)
    return await generate_email(
        action=payload.action,
        instruction=payload.instruction or payload.goal,
        refine_instruction=payload.refine_instruction,
        subject=payload.subject,
        body_text=payload.body_text,
        tone=payload.tone,
        length=payload.length,
        recipient=recipient,
        thread_snippet=payload.thread_snippet,
        db=ctx.db,
        workspace_id=ctx.workspace.id,
    )
