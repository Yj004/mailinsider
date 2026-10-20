from fastapi import APIRouter, Depends

from app.api.deps import Ctx, get_ctx
from app.errors import AppError
from app.models import Suppression
from app.schemas import SuppressionIn
from app.services.events import audit
from app.services.messaging import add_suppression, normalize_address
from app.services.signals import iso

router = APIRouter(prefix="/suppressions", tags=["suppressions"])


@router.get("")
def list_suppressions(ctx: Ctx = Depends(get_ctx)):
    rows = (
        ctx.db.query(Suppression)
        .filter(Suppression.workspace_id == ctx.workspace.id)
        .order_by(Suppression.created_at.desc())
        .limit(200)
        .all()
    )
    return {
        "suppressions": [
            {
                "id": row.id,
                "email": row.email,
                "reason": row.reason,
                "source": row.source,
                "created_at": iso(row.created_at),
            }
            for row in rows
        ]
    }


@router.post("")
def create_suppression(payload: SuppressionIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    email, _ = normalize_address(payload.email, None)
    row = add_suppression(
        ctx.db,
        workspace_id=ctx.workspace.id,
        email=email,
        reason=payload.reason or "manual",
        source="user",
    )
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="suppression_added",
        target_type="suppression",
        target_id=row.id,
        details={"email": email, "reason": row.reason},
    )
    ctx.db.commit()
    return {
        "id": row.id,
        "email": row.email,
        "reason": row.reason,
        "source": row.source,
        "created_at": iso(row.created_at),
    }


@router.delete("/{suppression_id}")
def delete_suppression(suppression_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    row = (
        ctx.db.query(Suppression)
        .filter(Suppression.id == suppression_id, Suppression.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if row is None:
        raise AppError(404, "not_found", "That suppression entry was not found.")
    ctx.db.delete(row)
    ctx.db.commit()
    return {"ok": True}
