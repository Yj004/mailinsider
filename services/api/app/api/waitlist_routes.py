from fastapi import APIRouter, Depends

from app.api.deps import Ctx, get_ctx
from app.core.access import require_operator_email
from app.models import WaitlistSignup
from app.services.signals import iso

router = APIRouter(prefix="/waitlist", tags=["waitlist"])


@router.get("")
def list_waitlist(ctx: Ctx = Depends(get_ctx)):
    require_operator_email(ctx.user.email)
    rows = ctx.db.query(WaitlistSignup).order_by(WaitlistSignup.created_at.desc()).all()
    return {
        "signups": [
            {
                "id": row.id,
                "name": row.name,
                "company_name": row.company_name,
                "email": row.email,
                "monthly_sends": row.monthly_sends,
                "willing_to_pay": row.willing_to_pay,
                "created_at": iso(row.created_at),
            }
            for row in rows
        ]
    }
