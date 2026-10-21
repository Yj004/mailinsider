import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from app.api.deps import Ctx, get_ctx
from app.core.config import get_settings
from app.core.security import decrypt_secret, encrypt_secret
from app.errors import AppError
from app.models import OAuthState, SheetConnection, SheetLog, Workspace, as_utc, utcnow
from pydantic import BaseModel, Field

from app.schemas import SheetImportIn
from app.services.events import audit
from app.services.gmail import NeedsReauth, authorization_url, exchange_code, refresh_access_token, revoke_token
from app.services.messaging import is_suppressed, upsert_contact
from app.services.sheets import (
    PENDING_SHEET_ID,
    create_private_spreadsheet,
    google_account_email,
    is_sheet_attached,
    list_account_spreadsheets,
    list_tabs,
    map_sheet_rows,
    preview_spreadsheet,
    read_sheet_values,
    spreadsheet_details,
)
from app.services.signals import iso

router = APIRouter(tags=["sheets"])


class AttachSheetIn(BaseModel):
    spreadsheet_id: str = Field(min_length=5, max_length=128)
    sheet_tab: str | None = Field(default=None, max_length=120)


def _payload(row: SheetConnection) -> dict:
    attached = is_sheet_attached(row)
    return {
        "id": row.id,
        "google_account_email": row.google_account_email,
        "spreadsheet_id": row.spreadsheet_id if attached else None,
        "spreadsheet_title": row.spreadsheet_title if attached else None,
        "spreadsheet_url": row.spreadsheet_url if attached else None,
        "sheet_tab": row.sheet_tab if attached else None,
        "status": row.status,
        "is_demo": row.is_demo,
        "sheet_attached": attached,
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
    }


def _retire(db, workspace_id: str) -> None:
    rows = (
        db.query(SheetConnection)
        .filter(SheetConnection.workspace_id == workspace_id, SheetConnection.status == "connected")
        .all()
    )
    for row in rows:
        if not row.is_demo and row.encrypted_refresh_token:
            revoke_token(decrypt_secret(row.encrypted_refresh_token))
        row.encrypted_refresh_token = ""
        row.status = "disconnected"
        row.updated_at = utcnow()


@router.get("/integrations/sheets/connections")
def list_sheets(ctx: Ctx = Depends(get_ctx)):
    rows = (
        ctx.db.query(SheetConnection)
        .filter(
            SheetConnection.workspace_id == ctx.workspace.id,
            SheetConnection.status.in_(("connected", "needs_reauth")),
        )
        .order_by(SheetConnection.created_at.desc())
        .all()
    )
    logs = (
        ctx.db.query(SheetLog)
        .filter(SheetLog.workspace_id == ctx.workspace.id)
        .order_by(SheetLog.created_at.desc())
        .limit(8)
        .all()
    )
    settings = get_settings()
    return {
        "connections": [_payload(row) for row in rows],
        "recent_rows": [
            {
                "id": item.id,
                "message_id": item.message_id,
                "created_at": iso(item.created_at),
                "demo": bool((item.details or {}).get("demo")),
                "row": (item.details or {}).get("row") or [],
            }
            for item in logs
        ],
        "oauth_configured": settings.google_oauth_configured,
        "demo_allowed": settings.demo_connections_allowed,
        "scope_reason": (
            "Connect your Google account, browse any spreadsheet you can open, preview tabs, "
            "then attach the one you want for send logging and contact import. "
            "Enable Google Sheets API and Google Drive API on the OAuth project."
        ),
    }


@router.post("/integrations/sheets/demo")
def connect_demo_sheet(ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    settings = get_settings()
    if not settings.demo_connections_allowed:
        raise AppError(
            400,
            "demo_disabled",
            "Demo sheet connections are disabled. Set ALLOW_DEMO_CONNECTIONS=true or connect Google Sheets.",
        )
    existing = (
        ctx.db.query(SheetConnection)
        .filter(
            SheetConnection.workspace_id == ctx.workspace.id,
            SheetConnection.is_demo.is_(True),
            SheetConnection.status == "connected",
        )
        .first()
    )
    if existing:
        return _payload(existing)
    _retire(ctx.db, ctx.workspace.id)
    row = SheetConnection(
        workspace_id=ctx.workspace.id,
        connected_by=ctx.user.id,
        google_account_email=ctx.user.email,
        spreadsheet_id=f"local-{ctx.workspace.id}",
        spreadsheet_title=f"{ctx.workspace.name} send log",
        spreadsheet_url="",
        sheet_tab="Sends",
        encrypted_refresh_token=encrypt_secret("demo"),
        granted_scopes=["demo"],
        status="connected",
        is_demo=True,
    )
    ctx.db.add(row)
    ctx.db.flush()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="sheet_demo_connected",
        target_type="sheet_connection",
        target_id=row.id,
        details={"local": True},
    )
    ctx.db.commit()
    ctx.db.refresh(row)
    return _payload(row)


@router.post("/integrations/sheets/connect")
def begin_sheet_connect(ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    settings = get_settings()
    if not settings.google_oauth_configured:
        raise AppError(
            400,
            "oauth_not_configured",
            "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET so this workspace can connect through the Google Sheets API.",
        )
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    ctx.db.add(
        OAuthState(
            state=state,
            workspace_id=ctx.workspace.id,
            user_id=ctx.user.id,
            code_verifier=verifier,
            purpose="sheets",
            expires_at=utcnow() + timedelta(minutes=15),
        )
    )
    ctx.db.commit()
    return {
        "authorization_url": authorization_url(
            state,
            verifier,
            scope=settings.sheets_scope,
            redirect_uri=settings.google_sheets_redirect_uri,
        )
    }


@router.get("/integrations/sheets/callback")
def sheet_callback(request: Request):
    import logging

    from app.core.database import SessionLocal

    log = logging.getLogger("mailinsider.sheets_oauth")
    db = SessionLocal()
    settings = get_settings()
    target = f"{settings.public_app_url.rstrip('/')}/app/integrations"
    try:
        error = request.query_params.get("error")
        state_value = request.query_params.get("state")
        code = request.query_params.get("code")
        if error or not state_value or not code:
            return RedirectResponse(f"{target}?sheets=denied", status_code=302)
        state = db.get(OAuthState, state_value)
        if state is None or state.purpose != "sheets" or as_utc(state.expires_at) < utcnow():
            return RedirectResponse(f"{target}?sheets=expired", status_code=302)
        try:
            token_payload = exchange_code(code, state.code_verifier, redirect_uri=settings.google_sheets_redirect_uri)
            refresh = token_payload.get("refresh_token")
            access = token_payload.get("access_token")
            if not refresh or not access:
                return RedirectResponse(f"{target}?sheets=missing_refresh", status_code=302)
            email = google_account_email(access)
        except AppError:
            return RedirectResponse(f"{target}?sheets=failed", status_code=302)
        scopes = [item for item in str(token_payload.get("scope") or settings.sheets_scope).split(" ") if item]
        _retire(db, state.workspace_id)
        # Account only — user browses and attaches any spreadsheet next.
        row = SheetConnection(
            workspace_id=state.workspace_id,
            connected_by=state.user_id,
            google_account_email=email,
            spreadsheet_id=PENDING_SHEET_ID,
            spreadsheet_title="Select a spreadsheet",
            spreadsheet_url="",
            sheet_tab="Sheet1",
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
            workspace_id=row.workspace_id,
            actor_user_id=row.connected_by,
            action="sheet_account_connected",
            target_type="sheet_connection",
            target_id=row.id,
            details={"email": email},
        )
        db.commit()
        return RedirectResponse(f"{target}?sheets=pick", status_code=302)
    except Exception:
        log.exception("sheets_oauth_callback_failed")
        db.rollback()
        return RedirectResponse(f"{target}?sheets=failed", status_code=302)
    finally:
        db.close()


def _active_sheet(ctx: Ctx, *, require_attached: bool = True) -> SheetConnection:
    row = (
        ctx.db.query(SheetConnection)
        .filter(SheetConnection.workspace_id == ctx.workspace.id, SheetConnection.status == "connected")
        .order_by(SheetConnection.created_at.desc())
        .first()
    )
    if row is None:
        raise AppError(400, "sheet_required", "Connect a Google account for Sheets first.")
    if require_attached and not is_sheet_attached(row):
        raise AppError(400, "sheet_required", "Browse and attach a spreadsheet before continuing.")
    return row


def _access_token(connection: SheetConnection) -> str:
    if connection.is_demo:
        raise AppError(400, "demo_sheet", "Demo sheet cannot browse Google Drive.")
    refresh = decrypt_secret(connection.encrypted_refresh_token)
    if not refresh:
        raise NeedsReauth()
    return refresh_access_token(refresh)


@router.get("/integrations/sheets/browse")
def browse_sheets(q: str | None = None, page_token: str | None = None, ctx: Ctx = Depends(get_ctx)):
    """List spreadsheets from the connected Google account."""
    ctx.require("member")
    connection = _active_sheet(ctx, require_attached=False)
    try:
        access = _access_token(connection)
        result = list_account_spreadsheets(access, query=q, page_token=page_token)
    except NeedsReauth as exc:
        connection.status = "needs_reauth"
        ctx.db.commit()
        raise AppError(403, "needs_reauth", "Reconnect Google Sheets to continue.") from exc
    return {
        "connection_id": connection.id,
        "google_account_email": connection.google_account_email,
        "attached_spreadsheet_id": connection.spreadsheet_id if is_sheet_attached(connection) else None,
        **result,
    }


@router.get("/integrations/sheets/browse/{spreadsheet_id}/preview")
def browse_sheet_preview(spreadsheet_id: str, tab: str | None = None, ctx: Ctx = Depends(get_ctx)):
    """Preview tabs and sample rows before attaching a spreadsheet."""
    ctx.require("member")
    connection = _active_sheet(ctx, require_attached=False)
    try:
        access = _access_token(connection)
        preview = preview_spreadsheet(access, spreadsheet_id, tab=tab)
    except NeedsReauth as exc:
        connection.status = "needs_reauth"
        ctx.db.commit()
        raise AppError(403, "needs_reauth", "Reconnect Google Sheets to continue.") from exc
    return {
        "connection_id": connection.id,
        **preview,
        "suggested_mapping": _suggest_mapping(preview.get("headers") or []),
    }


@router.post("/integrations/sheets/attach")
def attach_sheet(payload: AttachSheetIn, ctx: Ctx = Depends(get_ctx)):
    """Attach any spreadsheet the connected account can open."""
    ctx.require("member")
    connection = _active_sheet(ctx, require_attached=False)
    spreadsheet_id = payload.spreadsheet_id.strip()
    if spreadsheet_id == PENDING_SHEET_ID:
        raise AppError(400, "invalid_sheet", "Pick a real spreadsheet.")
    try:
        access = _access_token(connection)
        title, default_tab = spreadsheet_details(access, spreadsheet_id)
        tabs = list_tabs(access, spreadsheet_id)
    except NeedsReauth as exc:
        connection.status = "needs_reauth"
        ctx.db.commit()
        raise AppError(403, "needs_reauth", "Reconnect Google Sheets to continue.") from exc
    tab = (payload.sheet_tab or default_tab or (tabs[0] if tabs else "Sheet1")).strip() or "Sheet1"
    if tabs and tab not in tabs:
        raise AppError(400, "invalid_tab", f"Worksheet '{tab}' was not found in that spreadsheet.")
    connection.spreadsheet_id = spreadsheet_id
    connection.spreadsheet_title = title
    connection.spreadsheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
    connection.sheet_tab = tab
    connection.updated_at = utcnow()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="sheet_attached",
        target_type="sheet_connection",
        target_id=connection.id,
        details={"spreadsheet_id": spreadsheet_id, "tab": tab, "title": title},
    )
    ctx.db.commit()
    ctx.db.refresh(connection)
    return _payload(connection)


@router.post("/integrations/sheets/create-log")
def create_log_sheet(ctx: Ctx = Depends(get_ctx)):
    """Optional: create a fresh private MailInsider send-log spreadsheet and attach it."""
    ctx.require("member")
    connection = _active_sheet(ctx, require_attached=False)
    workspace = ctx.db.get(Workspace, ctx.workspace.id)
    title = f"MailInsider — {workspace.name}" if workspace else "MailInsider sends"
    try:
        access = _access_token(connection)
        spreadsheet_id, url, title, tab = create_private_spreadsheet(access, title)
    except NeedsReauth as exc:
        connection.status = "needs_reauth"
        ctx.db.commit()
        raise AppError(403, "needs_reauth", "Reconnect Google Sheets to continue.") from exc
    connection.spreadsheet_id = spreadsheet_id
    connection.spreadsheet_title = title
    connection.spreadsheet_url = url
    connection.sheet_tab = tab
    connection.updated_at = utcnow()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="sheet_log_created",
        target_type="sheet_connection",
        target_id=connection.id,
        details={"spreadsheet_id": spreadsheet_id},
    )
    ctx.db.commit()
    ctx.db.refresh(connection)
    return _payload(connection)


@router.get("/integrations/sheets/preview")
def preview_sheet(tab: str | None = None, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    connection = _active_sheet(ctx)
    try:
        tabs = ["Sends"] if connection.is_demo else None
        if not connection.is_demo:
            access = _access_token(connection)
            tabs = list_tabs(access, connection.spreadsheet_id)
        data = read_sheet_values(connection, tab=tab)
    except NeedsReauth as exc:
        connection.status = "needs_reauth"
        ctx.db.commit()
        raise AppError(403, "needs_reauth", "Reconnect Google Sheets to continue.") from exc
    headers = data["headers"]
    preview_rows = data["rows"][:10]
    return {
        "connection_id": connection.id,
        "spreadsheet_title": connection.spreadsheet_title,
        "tabs": tabs or [data["tab"]],
        "tab": data["tab"],
        "headers": headers,
        "preview_rows": preview_rows,
        "row_count": len(data["rows"]),
        "demo": data["demo"],
        "suggested_mapping": _suggest_mapping(headers),
    }


def _suggest_mapping(headers: list[str]) -> dict[str, str]:
    lowered = {header.lower().strip(): header for header in headers if header.strip()}
    mapping = {}
    for field, aliases in {
        "email": ["email", "e-mail", "email address", "mail"],
        "first_name": ["first_name", "firstname", "first name", "first"],
        "last_name": ["last_name", "lastname", "last name", "last"],
        "company": ["company", "organization", "org", "account"],
    }.items():
        for alias in aliases:
            if alias in lowered:
                mapping[field] = lowered[alias]
                break
    return mapping


@router.post("/integrations/sheets/import")
def import_sheet(payload: SheetImportIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("member")
    connection = _active_sheet(ctx)
    try:
        data = read_sheet_values(connection, tab=payload.tab)
        contacts, errors = map_sheet_rows(data["headers"], data["rows"], payload.mapping)
    except NeedsReauth as exc:
        connection.status = "needs_reauth"
        ctx.db.commit()
        raise AppError(403, "needs_reauth", "Reconnect Google Sheets to continue.") from exc
    imported = []
    skipped = []
    if payload.dry_run:
        for item in contacts:
            if is_suppressed(ctx.db, ctx.workspace.id, item["email"]):
                skipped.append({"email": item["email"], "reason": "suppressed", "row": item["row"]})
            else:
                imported.append(item)
        return {
            "dry_run": True,
            "imported_count": len(imported),
            "error_count": len(errors),
            "skipped_count": len(skipped),
            "contacts": imported[:50],
            "errors": errors[:50],
            "skipped": skipped[:50],
        }
    for item in contacts:
        if is_suppressed(ctx.db, ctx.workspace.id, item["email"]):
            skipped.append({"email": item["email"], "reason": "suppressed", "row": item["row"]})
            continue
        contact = upsert_contact(
            ctx.db,
            ctx.workspace.id,
            item["email"],
            item["name"],
            custom_fields=item["custom_fields"],
            source="google_sheet",
        )
        imported.append(
            {
                "id": contact.id,
                "email": contact.email,
                "name": contact.display_name,
                "custom_fields": contact.custom_fields or {},
                "row": item["row"],
            }
        )
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="sheet_contacts_imported",
        target_type="sheet_connection",
        target_id=connection.id,
        details={"imported": len(imported), "errors": len(errors), "skipped": len(skipped)},
    )
    ctx.db.commit()
    return {
        "dry_run": False,
        "imported_count": len(imported),
        "error_count": len(errors),
        "skipped_count": len(skipped),
        "contacts": imported[:100],
        "errors": errors[:50],
        "skipped": skipped[:50],
    }


@router.delete("/integrations/sheets/connections/{connection_id}")
def disconnect_sheet(connection_id: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("admin")
    row = (
        ctx.db.query(SheetConnection)
        .filter(SheetConnection.id == connection_id, SheetConnection.workspace_id == ctx.workspace.id)
        .one_or_none()
    )
    if row is None:
        raise AppError(404, "not_found", "That Google Sheet is not in this workspace.")
    if not row.is_demo and row.encrypted_refresh_token:
        revoke_token(decrypt_secret(row.encrypted_refresh_token))
    row.encrypted_refresh_token = ""
    row.status = "disconnected"
    row.updated_at = utcnow()
    audit(
        ctx.db,
        workspace_id=ctx.workspace.id,
        actor_user_id=ctx.user.id,
        action="sheet_disconnected",
        target_type="sheet_connection",
        target_id=row.id,
    )
    ctx.db.commit()
    return _payload(row)
