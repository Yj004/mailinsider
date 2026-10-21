import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.ai_pr_routes import router as ai_pr_router
from app.api.ai_routes import router as ai_router
from app.api.auth_routes import router as auth_router
from app.api.campaign_routes import router as campaign_router
from app.api.contact_routes import router as contact_router
from app.api.document_routes import router as document_router
from app.api.message_routes import router as message_router
from app.api.public_routes import router as public_router
from app.api.sheet_routes import router as sheet_router
from app.api.suppression_routes import router as suppression_router
from app.api.template_routes import router as template_router
from app.api.waitlist_routes import router as waitlist_router
from app.api.workspace_routes import router as workspace_router
from app.core.config import get_settings
from app.core.database import SessionLocal, get_db, init_db
from app.errors import AppError
from app.services.messaging import start_worker

log = logging.getLogger("mailinsider")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def _safe_path(path: str) -> str:
    if path.startswith("/t/") or path.startswith("/d/") or path.startswith("/api/v1/public/"):
        parts = [part for part in path.split("/") if part]
        if len(parts) >= 2:
            return "/" + "/".join(parts[:2]) + "/:token"
    return path


@asynccontextmanager
async def lifespan(_app: FastAPI):
    import os

    settings = get_settings()
    if settings.is_production and settings.jwt_secret in {"", "dev-only-change-me"}:
        raise RuntimeError("Set JWT_SECRET before running in production.")
    enc = (os.environ.get("TOKEN_ENCRYPTION_KEY") or settings.token_encryption_key or "").strip()
    if settings.is_production and not enc:
        raise RuntimeError("Set TOKEN_ENCRYPTION_KEY before running in production.")
    log.info(
        "startup env=%s oauth=%s token_encryption=%s",
        settings.app_env,
        settings.google_oauth_configured,
        bool(enc),
    )
    init_db()
    start_worker()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="MailInsider",
        version="0.1.0",
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = uuid.uuid4().hex[:16]
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        elapsed = int((time.perf_counter() - started) * 1000)
        log.info(
            "request %s %s %s %sms",
            request_id,
            request.method,
            _safe_path(request.url.path),
            elapsed,
        )
        return response

    def _error(request: Request, status: int, code: str, message: str) -> JSONResponse:
        request_id = getattr(request.state, "request_id", "")
        return JSONResponse(
            status_code=status,
            content={"error": {"code": code, "message": message, "request_id": request_id}},
        )

    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError):
        return _error(request, exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        parts = []
        for item in exc.errors():
            loc = " ".join(str(bit) for bit in item.get("loc", []) if bit != "body")
            text = item.get("msg", "Invalid value")
            parts.append(f"{loc}: {text}" if loc else text)
        return _error(request, 422, "invalid_request", "; ".join(parts) or "Check the form and try again.")

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        if isinstance(exc, HTTPException):
            detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
            return _error(request, exc.status_code, "http_error", detail)
        log.exception("unhandled")
        return _error(request, 500, "server_error", "Something went wrong. Try again.")

    @app.get("/health")
    def health():
        from sqlalchemy import text

        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
        return {"status": "ok"}

    api = "/api/v1"
    app.include_router(auth_router, prefix=api)
    app.include_router(ai_router, prefix=api)
    app.include_router(ai_pr_router, prefix=api)
    app.include_router(workspace_router, prefix=api)
    app.include_router(sheet_router, prefix=api)
    app.include_router(message_router, prefix=api)
    app.include_router(contact_router, prefix=api)
    app.include_router(document_router, prefix=api)
    app.include_router(template_router, prefix=api)
    app.include_router(campaign_router, prefix=api)
    app.include_router(suppression_router, prefix=api)
    app.include_router(waitlist_router, prefix=api)
    app.include_router(public_router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Workspace-Id"],
    )
    return app


app = create_app()
_ = get_db
