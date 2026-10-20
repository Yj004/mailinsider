from datetime import timedelta

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.limiter import limiter
from app.core.security import create_access_token, hash_password, hash_token, new_token, verify_password
from app.errors import AppError
from app.models import (
    as_utc,
    AuditLog,
    Contact,
    DocumentAccessToken,
    DocumentAsset,
    GmailConnection,
    SheetConnection,
    SheetLog,
    Message,
    MessageRecipient,
    OpenToken,
    PasswordReset,
    TrackingEvent,
    TrackingLink,
    User,
    Workspace,
    WorkspaceInvite,
    WorkspaceMember,
    utcnow,
)
from app.schemas import DeleteAccountIn, ForgotIn, LoginIn, PasswordIn, ProfileIn, RegisterIn, ResetIn
from app.services.events import audit
from app.services.messaging import normalize_address
from app.services.sample import clear_sample

from .deps import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


def _password_ok(password: str, email: str) -> None:
    if len(password) < 10:
        raise AppError(400, "weak_password", "Use at least 10 characters.")
    if len(password) > 200:
        raise AppError(400, "weak_password", "Use a password of 200 characters or fewer.")
    if password.lower() == email.lower():
        raise AppError(400, "weak_password", "Use a password that is not your email address.")


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _memberships(db: Session, user: User) -> list[dict]:
    rows = (
        db.query(WorkspaceMember, Workspace)
        .join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
        .filter(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.created_at.asc())
        .all()
    )
    return [
        {
            "workspace_id": workspace.id,
            "name": workspace.name,
            "role": member.role,
            "open_tracking_default": workspace.open_tracking_default,
            "link_tracking_default": workspace.link_tracking_default,
            "retention_days": workspace.retention_days,
        }
        for member, workspace in rows
    ]


def _user_payload(user: User) -> dict:
    return {"id": user.id, "email": user.email, "display_name": user.display_name}


def _session(db: Session, user: User) -> dict:
    return {
        "access_token": create_access_token(user.id),
        "token_type": "bearer",
        "user": _user_payload(user),
        "memberships": _memberships(db, user),
    }


def _accept_invites(db: Session, user: User) -> None:
    invites = (
        db.query(WorkspaceInvite)
        .filter(WorkspaceInvite.email == user.email, WorkspaceInvite.accepted_at.is_(None))
        .all()
    )
    for invite in invites:
        exists = db.get(WorkspaceMember, {"workspace_id": invite.workspace_id, "user_id": user.id})
        if exists is None:
            db.add(WorkspaceMember(workspace_id=invite.workspace_id, user_id=user.id, role=invite.role))
            audit(
                db,
                workspace_id=invite.workspace_id,
                actor_user_id=user.id,
                action="invite_accepted",
                target_type="user",
                target_id=user.id,
                details={"role": invite.role},
            )
        invite.accepted_at = utcnow()


@router.post("/register")
def register(payload: RegisterIn, request: Request, db: Session = Depends(get_db)):
    if not limiter.allow(f"register:{_client(request)}", 8, 60):
        raise AppError(429, "rate_limited", "Too many attempts. Wait a minute and try again.")
    email, _ = normalize_address(payload.email, None)
    _password_ok(payload.password, email)
    if db.query(User).filter(User.email == email).one_or_none():
        raise AppError(400, "email_taken", "An account with that email already exists. Sign in instead.")
    user = User(email=email, password_hash=hash_password(payload.password), display_name=payload.display_name.strip())
    db.add(user)
    db.flush()
    workspace = Workspace(
        name=payload.workspace_name.strip(),
        created_by=user.id,
        open_tracking_default=payload.open_tracking_default,
        link_tracking_default=payload.link_tracking_default,
    )
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    audit(
        db,
        workspace_id=workspace.id,
        actor_user_id=user.id,
        action="workspace_created",
        target_type="workspace",
        target_id=workspace.id,
    )
    _accept_invites(db, user)
    db.commit()
    return _session(db, user)


@router.post("/login")
def login(payload: LoginIn, request: Request, db: Session = Depends(get_db)):
    email, _ = normalize_address(payload.email, None)
    if not limiter.allow(f"login:{email}:{_client(request)}", 10, 60):
        raise AppError(429, "rate_limited", "Too many sign-in attempts. Wait a minute and try again.")
    user = db.query(User).filter(User.email == email).one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise AppError(401, "invalid_login", "That email and password do not match.")
    return _session(db, user)


@router.post("/forgot")
def forgot(payload: ForgotIn, request: Request, db: Session = Depends(get_db)):
    if not limiter.allow(f"forgot:{_client(request)}", 8, 60):
        raise AppError(429, "rate_limited", "Too many attempts. Wait a minute and try again.")
    email, _ = normalize_address(payload.email, None)
    user = db.query(User).filter(User.email == email).one_or_none()
    response = {
        "message": "If an account exists for that email, a reset code is ready. In local development the code is shown here."
    }
    if user is None:
        return response
    raw = new_token()
    db.add(
        PasswordReset(
            user_id=user.id,
            token_hash=hash_token(raw),
            expires_at=utcnow() + timedelta(hours=1),
        )
    )
    db.commit()
    if not get_settings().is_production:
        response["reset_token"] = raw
    return response


@router.post("/reset")
def reset_password(payload: ResetIn, db: Session = Depends(get_db)):
    row = db.query(PasswordReset).filter(PasswordReset.token_hash == hash_token(payload.token)).one_or_none()
    if row is None or row.used_at is not None or as_utc(row.expires_at) < utcnow():
        raise AppError(400, "invalid_reset", "That reset code is invalid or expired. Request a new one.")
    user = db.get(User, row.user_id)
    if user is None:
        raise AppError(400, "invalid_reset", "That reset code is invalid or expired. Request a new one.")
    _password_ok(payload.password, user.email)
    user.password_hash = hash_password(payload.password)
    row.used_at = utcnow()
    db.commit()
    return _session(db, user)


@router.get("/me")
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"user": _user_payload(user), "memberships": _memberships(db, user)}


@router.patch("/me")
def update_me(payload: ProfileIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.display_name = payload.display_name.strip()
    db.commit()
    return {"user": _user_payload(user), "memberships": _memberships(db, user)}


@router.post("/password")
def change_password(payload: PasswordIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not verify_password(payload.current_password, user.password_hash):
        raise AppError(400, "invalid_password", "The current password is not correct.")
    _password_ok(payload.new_password, user.email)
    user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"updated": True}


@router.post("/delete")
def delete_account(payload: DeleteAccountIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if payload.confirm != "DELETE":
        raise AppError(400, "confirm_required", 'Type DELETE to confirm account deletion.')
    if not verify_password(payload.password, user.password_hash):
        raise AppError(400, "invalid_password", "The password is not correct.")
    owned = (
        db.query(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == user.id, WorkspaceMember.role == "owner")
        .all()
    )
    for workspace in owned:
        others = (
            db.query(WorkspaceMember)
            .filter(WorkspaceMember.workspace_id == workspace.id, WorkspaceMember.user_id != user.id)
            .count()
        )
        if others:
            raise AppError(
                400,
                "transfer_required",
                f'"{workspace.name}" still has other members. Remove them or ask an owner to stay behind before deleting your account.',
            )
        _delete_workspace(db, workspace)
    db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).delete(synchronize_session=False)
    db.query(PasswordReset).filter(PasswordReset.user_id == user.id).delete(synchronize_session=False)
    db.delete(user)
    db.commit()
    return {"deleted": True}


def _delete_workspace(db: Session, workspace: Workspace) -> None:
    from app.services.document_storage import delete_bytes

    clear_sample(db, workspace, commit=False)
    documents = db.query(DocumentAsset).filter(DocumentAsset.workspace_id == workspace.id).all()
    for document in documents:
        delete_bytes(document.storage_path)
    message_ids = [row[0] for row in db.query(Message.id).filter(Message.workspace_id == workspace.id).all()]
    recipient_ids = [
        row[0]
        for row in db.query(MessageRecipient.id).filter(MessageRecipient.workspace_id == workspace.id).all()
    ]
    db.query(TrackingEvent).filter(TrackingEvent.workspace_id == workspace.id).delete(synchronize_session=False)
    if recipient_ids:
        db.query(TrackingLink).filter(TrackingLink.message_recipient_id.in_(recipient_ids)).delete(
            synchronize_session=False
        )
        db.query(OpenToken).filter(OpenToken.message_recipient_id.in_(recipient_ids)).delete(synchronize_session=False)
        db.query(DocumentAccessToken).filter(DocumentAccessToken.message_recipient_id.in_(recipient_ids)).delete(
            synchronize_session=False
        )
    db.query(DocumentAccessToken).filter(DocumentAccessToken.workspace_id == workspace.id).delete(
        synchronize_session=False
    )
    db.query(SheetLog).filter(SheetLog.workspace_id == workspace.id).delete(synchronize_session=False)
    if message_ids:
        db.query(MessageRecipient).filter(MessageRecipient.message_id.in_(message_ids)).delete(synchronize_session=False)
        db.query(Message).filter(Message.id.in_(message_ids)).delete(synchronize_session=False)
    db.query(DocumentAsset).filter(DocumentAsset.workspace_id == workspace.id).delete(synchronize_session=False)
    db.query(Contact).filter(Contact.workspace_id == workspace.id).delete(synchronize_session=False)
    db.query(GmailConnection).filter(GmailConnection.workspace_id == workspace.id).delete(synchronize_session=False)
    db.query(SheetConnection).filter(SheetConnection.workspace_id == workspace.id).delete(synchronize_session=False)
    db.query(WorkspaceInvite).filter(WorkspaceInvite.workspace_id == workspace.id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.workspace_id == workspace.id).delete(synchronize_session=False)
    db.query(WorkspaceMember).filter(WorkspaceMember.workspace_id == workspace.id).delete(synchronize_session=False)
    db.delete(workspace)
