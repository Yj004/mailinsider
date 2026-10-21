from dataclasses import dataclass

from fastapi import Depends, Header
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.access import require_operator_email
from app.core.database import get_db
from app.core.security import decode_access_token
from app.errors import AppError
from app.models import User, Workspace, WorkspaceMember
from app.services.messaging import ROLE_RANK

bearer = HTTPBearer(auto_error=False)


@dataclass
class Ctx:
    db: Session
    user: User
    workspace: Workspace
    membership: WorkspaceMember

    def require(self, minimum: str) -> None:
        if ROLE_RANK[self.membership.role] < ROLE_RANK[minimum]:
            if minimum == "member":
                message = "Viewers can review engagement, but only members can send, upload, or change messages."
            else:
                message = "Only owners and admins can do that."
            raise AppError(403, "forbidden", message)


def get_current_user(
    db: Session = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise AppError(401, "unauthorized", "Sign in to continue.")
    user_id = decode_access_token(credentials.credentials)
    if not user_id:
        raise AppError(401, "unauthorized", "Your session expired. Sign in again.")
    user = db.get(User, user_id)
    if user is None:
        raise AppError(401, "unauthorized", "Sign in to continue.")
    require_operator_email(user.email)
    return user


def get_ctx(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    x_workspace_id: str | None = Header(default=None),
) -> Ctx:
    memberships = db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).all()
    if not memberships:
        raise AppError(403, "no_workspace", "You are not a member of a workspace.")
    chosen = None
    if x_workspace_id:
        chosen = next((item for item in memberships if item.workspace_id == x_workspace_id), None)
        if chosen is None:
            raise AppError(403, "forbidden", "You do not belong to that workspace.")
    elif len(memberships) == 1:
        chosen = memberships[0]
    else:
        raise AppError(400, "workspace_required", "Choose a workspace and try again.")
    workspace = db.get(Workspace, chosen.workspace_id)
    if workspace is None:
        raise AppError(404, "not_found", "That workspace is not available.")
    return Ctx(db=db, user=user, workspace=workspace, membership=chosen)
