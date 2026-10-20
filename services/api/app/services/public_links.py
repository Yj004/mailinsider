"""Outbound public HTTPS bases for email links (never localhost for recipients)."""

from __future__ import annotations

from urllib.parse import urlparse

from app.core.config import get_settings


def _is_loopback(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return True
    return host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or not host


def supabase_functions_base() -> str:
    settings = get_settings()
    base = (settings.supabase_url or "").rstrip("/")
    if not base:
        return ""
    return f"{base}/functions/v1"


def public_document_url(token: str) -> str:
    """Direct PDF/view link that works on any device (Supabase edge function preferred)."""
    settings = get_settings()
    explicit = (getattr(settings, "public_document_url", None) or "").rstrip("/")
    if explicit:
        return f"{explicit}/{token}"
    fn = supabase_functions_base()
    if fn:
        return f"{fn}/view-document/{token}"
    # Local/dev fallback — only useful on the same machine.
    return f"{settings.public_api_url.rstrip('/')}/api/v1/public/documents/{token}/file"


def public_click_url(token: str) -> str:
    settings = get_settings()
    explicit = (getattr(settings, "public_click_url", None) or "").rstrip("/")
    if explicit:
        return f"{explicit}/{token}"
    fn = supabase_functions_base()
    if fn and _is_loopback(settings.public_api_url):
        return f"{fn}/track-click/{token}"
    return f"{settings.public_api_url.rstrip('/')}/t/click/{token}"


def public_unsubscribe_url(token: str) -> str:
    settings = get_settings()
    # Unsubscribe still hits the API when publicly reachable; otherwise omit campaigns on localhost.
    return f"{settings.public_api_url.rstrip('/')}/t/unsubscribe/{token}"


def is_mailinsider_tracking_url(url: str) -> bool:
    """True if URL is already a MailInsider tracking/document public link."""
    settings = get_settings()
    candidates = [
        settings.public_api_url.rstrip("/") + "/t/",
        settings.public_api_url.rstrip("/") + "/d/",
        settings.public_api_url.rstrip("/") + "/api/v1/public/documents/",
        supabase_functions_base() + "/view-document/",
        supabase_functions_base() + "/track-click/",
        supabase_functions_base() + "/open-pixel/",
        (settings.public_open_pixel_url or "").rstrip("/") + "/",
        (getattr(settings, "public_document_url", None) or "").rstrip("/") + "/",
        (getattr(settings, "public_click_url", None) or "").rstrip("/") + "/",
    ]
    return any(url.startswith(prefix) for prefix in candidates if prefix and prefix != "/")
