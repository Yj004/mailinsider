import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from app.api.deps import Ctx, get_ctx
from app.core.access import require_operator_email
from app.core.config import get_settings
from app.core.security import decrypt_secret, encrypt_secret, new_token
from app.errors import AppError
from app.models import (
    as_utc,
    AuditLog,
    GmailConnection,
    OAuthState,
    User,
    Workspace,
    WorkspaceInvite,
    WorkspaceMember,
    utcnow,
)
from app.schemas import MemberIn, MemberPatch, WorkspaceIn, WorkspacePatch
from app.services.events import audit
from app.services.gmail import authorization_url, exchange_code, gmail_profile, revoke_token
from app.services.messaging import normalize_address
from app.services.sample import clear_sample, load_sample
from app.services.signals import iso

router = APIRouter(tags=["workspace"])


def _workspace_payload(workspace: Workspace, role: str) -> dict:
    return {
        "id": workspace.id,
        "name": workspace.name,
        "role": role,
        "open_tracking_default": workspace.open_tracking_default,
        "link_tracking_default": workspace.link_tracking_default,
        "retention_days": workspace.retention_days,
        "created_at": iso(workspace.created_at),
    }


@router.get("/workspaces")
def list_workspaces(ctx: Ctx = Depends(get_ctx)):
    rows = (
        ctx.db.query(WorkspaceMember, Workspace)
        .join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
        .filter(WorkspaceMember.user_id == ctx.user.id)
        .all()
    )
    return {"workspaces": [_workspace_payload(workspace, member.role) for member, workspace in rows]}


@router.post("/workspaces")
def create_workspace(payload: WorkspaceIn, ctx: Ctx = Depends(get_ctx)):
    require_operator_email(ctx.user.email)
    workspace = Workspace(
        name=payload.name.strip(),
        created_by=ctx.user.id,
        open_tracking_default=payload.open_tracking_default,
        link_tracking_default=payload.link_tracking_default,
    )
    ctx.db.add(workspace)
    ctx.db.flush()
    ctx.db.add(WorkspaceMember(workspace_id=workspace.id, user_id=ctx.user.id, role="owner"))
    audit(
        ctx.db,
        workspace_id=workspace.id,
        actor_user_id=ctx.user.id,
        action="workspace_created",
        target_type="workspace",
        target_id=workspace.id,
    )
    ctx.db.commit()
    return _workspace_payload(workspace, "owner")


@router.patch("/workspaces/current")
def update_workspace(payload: WorkspacePatch, ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    if payload.name is not None:
        ctx.workspace.name = payload.name.strip()
    if payload.open_tracking_default is not None:
        ctx.workspace.open_tracking_default = payload.open_tracking_default
    if payload.link_tracking_default is not None:
        ctx.workspace.link_tracking_default = payload.link_tracking_default
    if payload.retention_days is not None:
        ctx.workspace.retention_days = payload.retention_days
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="workspace_updated",
        target_type="workspace",
        target_id=ctx.workspace.id,
    )
    ctx.db.commit()
    return _workspace_payload(ctx.workspace, ctx.membership.role)


@router.get("/workspaces/current/members")
def list_members(ctx: Ctx = Depends(get_ctx)):
    members = (
        ctx.db.query(WorkspaceMember, User)
        .join(User, User.id == WorkspaceMember.user_id)
        .filter(WorkspaceMember.workspace_id == ctx.workspace.id)
        .all()
    )
    invites = (
        ctx.db.query(WorkspaceInvite)
        .filter(WorkspaceInvite.workspace_id == ctx.workspace.id, WorkspaceInvite.accepted_at.is_(None))
        .all()
    )
    return {
        "members": [
            {
                "user_id": user.id,
                "email": user.email,
                "display_name": user.display_name,
                "role": member.role,
                "created_at": iso(member.created_at),
            }
            for member, user in members
        ],
        "invites": [
            {"id": invite.id, "email": invite.email, "role": invite.role, "created_at": iso(invite.created_at)}
            for invite in invites
        ],
    }


@router.post("/workspaces/current/members")
def add_member(payload: MemberIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    email, _ = normalize_address(payload.email, None)
    existing_user = ctx.db.query(User).filter(User.email == email).one_or_none()
    if existing_user:
        already = ctx.db.get(WorkspaceMember, (ctx.workspace.id, existing_user.id))
        if already:
            raise AppError(400, "already_member", "That person is already in this workspace.")
        ctx.db.add(WorkspaceMember(workspace_id=ctx.workspace.id, user_id=existing_user.id, role=payload.role))
        action = "member_added"
        target_id = existing_user.id
    else:
        invite = (
            ctx.db.query(WorkspaceInvite)
            .filter(WorkspaceInvite.workspace_id == ctx.workspace.id, WorkspaceInvite.email == email)
            .one_or_none()
        )
        if invite and invite.accepted_at is None:
            invite.role = payload.role
        elif invite:
            invite.role = payload.role
            invite.accepted_at = None
        else:
            ctx.db.add(
                WorkspaceInvite(
                    workspace_id=ctx.workspace.id,
                    email=email,
                    role=payload.role,
                    invited_by=ctx.user.id,
                )
            )
        action = "member_invited"
        target_id = None
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action=action,
        target_type="user",
        target_id=target_id,
        details={"email": email, "role": payload.role},
    )
    ctx.db.commit()
    return list_members(ctx)


@router.patch("/workspaces/current/members/{user_id}")
def change_role(user_id: str, payload: MemberPatch, ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    member = ctx.db.get(WorkspaceMember, (ctx.workspace.id, user_id))
    if member is None:
        raise AppError(404, "not_found", "That person is not in this workspace.")
    if member.role == "owner" and ctx.membership.role != "owner":
        raise AppError(403, "forbidden", "Only an owner can change another owner's role.")
    if payload.role == "owner" and ctx.membership.role != "owner":
        raise AppError(403, "forbidden", "Only an owner can name another owner.")
    if member.role == "owner" and payload.role != "owner":
        _ensure_other_owner(ctx, user_id)
    member.role = payload.role
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="member_role_changed",
        target_type="user",
        target_id=user_id,
        details={"role": payload.role},
    )
    ctx.db.commit()
    return list_members(ctx)


@router.delete("/workspaces/current/members/{user_id}")
def remove_member(user_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    member = ctx.db.get(WorkspaceMember, (ctx.workspace.id, user_id))
    if member is None:
        raise AppError(404, "not_found", "That person is not in this workspace.")
    if member.role == "owner":
        if ctx.membership.role != "owner":
            raise AppError(403, "forbidden", "Only an owner can remove an owner.")
        _ensure_other_owner(ctx, user_id)
    if member.role == "admin" and ctx.membership.role != "owner" and user_id != ctx.user.id:
        raise AppError(403, "forbidden", "Only an owner can remove an admin.")
    ctx.db.delete(member)
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="member_removed",
        target_type="user",
        target_id=user_id,
    )
    ctx.db.commit()
    return list_members(ctx)


def _ensure_other_owner(ctx: Ctx, user_id: str) -> None:
    owners = (
        ctx.db.query(WorkspaceMember)
        .filter(
            WorkspaceMember.workspace_id == ctx.workspace.id,
            WorkspaceMember.role == "owner",
            WorkspaceMember.user_id != user_id,
        )
        .count()
    )
    if owners == 0:
        raise AppError(400, "last_owner", "A workspace needs at least one owner.")


@router.get("/workspaces/current/audit")
def audit_log(ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    rows = (
        ctx.db.query(AuditLog)
        .filter(AuditLog.workspace_id == ctx.workspace.id)
        .order_by(AuditLog.created_at.desc())
        .limit(200)
        .all()
    )
    return {
        "entries": [
            {
                "id": row.id,
                "action": row.action,
                "actor_user_id": row.actor_user_id,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "created_at": iso(row.created_at),
                "metadata": row.details or {},
            }
            for row in rows
        ]
    }


@router.get("/workspaces/current/export")
def export_workspace(ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    from app.models import DocumentAsset, Message, MessageRecipient, TrackingEvent

    messages = (
        ctx.db.query(Message).filter(Message.workspace_id == ctx.workspace.id).order_by(Message.created_at.desc()).all()
    )
    message_ids = [item.id for item in messages]
    recipients = (
        ctx.db.query(MessageRecipient).filter(MessageRecipient.message_id.in_(message_ids)).all() if message_ids else []
    )
    events = (
        ctx.db.query(TrackingEvent).filter(TrackingEvent.workspace_id == ctx.workspace.id).all() if message_ids else []
    )
    documents = ctx.db.query(DocumentAsset).filter(DocumentAsset.workspace_id == ctx.workspace.id).all()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="workspace_exported",
        target_type="workspace",
        target_id=ctx.workspace.id,
    )
    ctx.db.commit()
    return {
        "workspace": _workspace_payload(ctx.workspace, ctx.membership.role),
        "messages": [
            {
                "id": item.id,
                "subject": item.subject,
                "body_text": item.body_text,
                "send_status": item.send_status,
                "from_email": item.from_email,
                "is_sample": item.is_sample,
                "created_at": iso(item.created_at),
                "sent_at": iso(item.sent_at),
            }
            for item in messages
        ],
        "recipients": [
            {
                "id": item.id,
                "message_id": item.message_id,
                "email": item.email_snapshot,
                "name": item.display_name_snapshot,
                "type": item.recipient_type,
                "send_status": item.send_status,
            }
            for item in recipients
        ],
        "events": [
            {
                "id": item.id,
                "message_id": item.message_id,
                "event_type": item.event_type,
                "source": item.source,
                "occurred_at": iso(item.occurred_at),
                "metadata": {
                    "possible_automated": int((item.details or {}).get("possible_automated") or 0),
                    "counts_toward_metric": int((item.details or {}).get("counts_toward_metric") or 0),
                    "page": (item.details or {}).get("page"),
                },
            }
            for item in events
        ],
        "documents": [
            {"id": item.id, "filename": item.filename, "content_type": item.content_type, "size_bytes": item.size_bytes}
            for item in documents
        ],
    }


@router.post("/workspaces/current/sample")
def create_sample(ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    return load_sample(ctx.db, ctx.workspace, ctx.user)


@router.delete("/workspaces/current/sample")
def delete_sample(ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    clear_sample(ctx.db, ctx.workspace)
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="sample_cleared",
        target_type="workspace",
        target_id=ctx.workspace.id,
    )
    ctx.db.commit()
    return {"cleared": True}


GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"


def _can_sync_replies(scopes: list | None) -> bool:
    granted = " ".join(scopes or [])
    return GMAIL_READONLY_SCOPE in granted or "gmail.readonly" in granted


def _connection_payload(row: GmailConnection) -> dict:
    scopes = row.granted_scopes or []
    return {
        "id": row.id,
        "google_account_email": row.google_account_email,
        "status": row.status,
        "is_demo": row.is_demo,
        "granted_scopes": scopes,
        "can_sync_replies": bool(row.is_demo) or _can_sync_replies(scopes),
        "needs_reconnect": bool(
            row.status == "connected" and not row.is_demo and not _can_sync_replies(scopes)
        ),
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
    }


@router.get("/integrations/gmail/connections")
def list_connections(ctx: Ctx = Depends(get_ctx)):
    rows = (
        ctx.db.query(GmailConnection)
        .filter(
            GmailConnection.workspace_id == ctx.workspace.id,
            GmailConnection.status.in_(("connected", "needs_reauth")),
        )
        .order_by(GmailConnection.created_at.desc())
        .all()
    )
    settings = get_settings()
    needs_reconnect = any(
        row.status == "connected" and not row.is_demo and not _can_sync_replies(row.granted_scopes)
        for row in rows
    )
    return {
        "connections": [_connection_payload(row) for row in rows],
        "oauth_configured": settings.google_oauth_configured,
        "demo_allowed": settings.demo_connections_allowed,
        "scope": settings.gmail_send_scope,
        "scope_reason": "Connect uses gmail.send to deliver mail, gmail.readonly to show recipient replies in the same thread, and userinfo.email to identify the account. Reconnect if you connected before reply sync was added.",
        "needs_reconnect": needs_reconnect,
    }


@router.post("/integrations/gmail/demo")
def connect_demo(ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    settings = get_settings()
    if not settings.demo_connections_allowed:
        raise AppError(
            400,
            "demo_disabled",
            "Demo connections are disabled. Set ALLOW_DEMO_CONNECTIONS=true or connect a real Gmail account.",
        )
    existing = (
        ctx.db.query(GmailConnection)
        .filter(
            GmailConnection.workspace_id == ctx.workspace.id,
            GmailConnection.is_demo.is_(True),
            GmailConnection.status == "connected",
        )
        .first()
    )
    if existing:
        return _connection_payload(existing)
    row = GmailConnection(
        workspace_id=ctx.workspace.id,
        connected_by=ctx.user.id,
        google_account_email=ctx.user.email,
        encrypted_refresh_token=encrypt_secret("demo"),
        granted_scopes=["demo"],
        status="connected",
        is_demo=True,
    )
    ctx.db.add(row)
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="gmail_demo_connected",
        target_type="gmail_connection",
        target_id=row.id,
    )
    ctx.db.commit()
    ctx.db.refresh(row)
    return _connection_payload(row)


@router.get("/integrations/gmail/connect")
def begin_connect(ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    settings = get_settings()
    if not settings.google_oauth_configured:
        raise AppError(
            400,
            "oauth_not_configured",
            "Google OAuth is not configured on this server. Add the client id and secret, or use a demo connection locally.",
        )
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    ctx.db.add(
        OAuthState(
            state=state,
            workspace_id=ctx.workspace.id,
            user_id=ctx.user.id,
            code_verifier=verifier,
            expires_at=utcnow() + timedelta(minutes=15),
        )
    )
    ctx.db.commit()
    return {"authorization_url": authorization_url(state, verifier)}


@router.get("/integrations/gmail/callback")
def oauth_callback(request: Request):
    import logging

    from app.core.database import SessionLocal

    log = logging.getLogger("mailinsider.gmail_oauth")
    db = SessionLocal()
    settings = get_settings()
    target = f"{settings.public_app_url.rstrip('/')}/app/integrations"
    try:
        error = request.query_params.get("error")
        state_value = request.query_params.get("state")
        code = request.query_params.get("code")
        if error or not state_value or not code:
            return RedirectResponse(f"{target}?gmail=denied", status_code=302)
        state = db.get(OAuthState, state_value)
        if state is None or as_utc(state.expires_at) < utcnow():
            return RedirectResponse(f"{target}?gmail=expired", status_code=302)
        try:
            token_payload = exchange_code(code, state.code_verifier)
            refresh = token_payload.get("refresh_token")
            access = token_payload.get("access_token")
            if not refresh or not access:
                return RedirectResponse(f"{target}?gmail=missing_refresh", status_code=302)
            email = gmail_profile(access)
        except AppError:
            return RedirectResponse(f"{target}?gmail=failed", status_code=302)
        scopes = [item for item in str(token_payload.get("scope") or settings.gmail_send_scope).split(" ") if item]
        workspace_id = state.workspace_id
        user_id = state.user_id
        existing = (
            db.query(GmailConnection)
            .filter(
                GmailConnection.workspace_id == workspace_id,
                GmailConnection.google_account_email == email,
                GmailConnection.is_demo.is_(False),
            )
            .order_by(GmailConnection.updated_at.desc())
            .first()
        )
        if existing is not None:
            existing.connected_by = user_id
            existing.encrypted_refresh_token = encrypt_secret(refresh)
            existing.granted_scopes = scopes
            existing.status = "connected"
            existing.updated_at = utcnow()
            row = existing
            # Drop duplicate connected rows for the same account so send/sync use one connection.
            duplicates = (
                db.query(GmailConnection)
                .filter(
                    GmailConnection.workspace_id == workspace_id,
                    GmailConnection.google_account_email == email,
                    GmailConnection.is_demo.is_(False),
                    GmailConnection.id != existing.id,
                    GmailConnection.status == "connected",
                )
                .all()
            )
            for dup in duplicates:
                dup.status = "disconnected"
                dup.encrypted_refresh_token = ""
                dup.updated_at = utcnow()
        else:
            row = GmailConnection(
                workspace_id=workspace_id,
                connected_by=user_id,
                google_account_email=email,
                encrypted_refresh_token=encrypt_secret(refresh),
                granted_scopes=scopes,
                status="connected",
                is_demo=False,
            )
            db.add(row)
        db.delete(state)
        db.flush()
        audit(
            db,
            workspace_id=workspace_id,
            actor_user_id=user_id,
            action="gmail_connected",
            target_type="gmail_connection",
            target_id=row.id,
            details={"email": email, "can_sync_replies": _can_sync_replies(scopes)},
        )
        db.commit()
        flag = "connected" if _can_sync_replies(scopes) else "scope_missing"
        return RedirectResponse(f"{target}?gmail={flag}", status_code=302)
    except Exception:
        log.exception("gmail_oauth_callback_failed")
        db.rollback()
        return RedirectResponse(f"{target}?gmail=failed", status_code=302)
    finally:
        db.close()


@router.delete("/integrations/gmail/connections/{connection_id}")
def disconnect(connection_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    row = (
        ctx.db.query(GmailConnection)
        .filter(GmailConnection.id == connection_id, GmailConnection.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if row is None:
        raise AppError(404, "not_found", "That Gmail connection is not in this workspace.")
    if not row.is_demo and row.encrypted_refresh_token:
        revoke_token(decrypt_secret(row.encrypted_refresh_token))
    row.encrypted_refresh_token = ""
    row.status = "disconnected"
    row.updated_at = utcnow()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="gmail_disconnected",
        target_type="gmail_connection",
        target_id=row.id,
    )
    ctx.db.commit()
    return _connection_payload(row)
