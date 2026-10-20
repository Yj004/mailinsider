from fastapi import APIRouter, Depends

from app.api.deps import Ctx, get_ctx
from app.errors import AppError
from app.models import EmailTemplate, utcnow
from app.schemas import TemplateIn, TemplatePatch
from app.services.events import audit
from app.services.signals import iso

router = APIRouter(prefix="/templates", tags=["templates"])


def _payload(row: EmailTemplate) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "subject": row.subject,
        "body_text": row.body_text,
        "body_html": row.body_html,
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
    }


def _owned(ctx: Ctx, template_id: str) -> EmailTemplate:
    row = (
        ctx.db.query(EmailTemplate)
        .filter(EmailTemplate.id == template_id, EmailTemplate.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if row is None:
        raise AppError(404, "not_found", "That template is not in this workspace.")
    return row


@router.get("")
def list_templates(ctx: Ctx = Depends(get_ctx)):
    rows = (
        ctx.db.query(EmailTemplate)
        .filter(EmailTemplate.workspace_id == ctx.workspace.id)
        .order_by(EmailTemplate.updated_at.desc())
        .all()
    )
    return {"templates": [_payload(row) for row in rows]}


@router.post("")
def create_template(payload: TemplateIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = EmailTemplate(
        workspace_id=ctx.workspace.id,
        created_by=ctx.user.id,
        name=payload.name.strip(),
        subject=payload.subject.strip(),
        body_text=payload.body_text,
        body_html=payload.body_html,
    )
    ctx.db.add(row)
    ctx.db.flush()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="template_created",
        target_type="email_template",
        target_id=row.id,
        details={"name": row.name},
    )
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(row)


@router.get("/{template_id}")
def get_template(template_id: str, ctx: Ctx = Depends(get_ctx)):
    return _payload(_owned(ctx, template_id))


@router.patch("/{template_id}")
def patch_template(template_id: str, payload: TemplatePatch, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = _owned(ctx, template_id)
    if payload.name is not None:
        row.name = payload.name.strip()
    if payload.subject is not None:
        row.subject = payload.subject.strip()
    if payload.body_text is not None:
        row.body_text = payload.body_text
    if payload.body_html is not None:
        row.body_html = payload.body_html
    row.updated_at = utcnow()
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(row)


@router.delete("/{template_id}")
def delete_template(template_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = _owned(ctx, template_id)
    ctx.db.delete(row)
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="template_deleted",
        target_type="email_template",
        target_id=template_id,
        details={},
    )
    ctx.db.commit()
    return {"ok": True}
