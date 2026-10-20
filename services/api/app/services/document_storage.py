"""Document bytes live in Supabase Storage only (private `documents` bucket).

Local disk is used only when APP is in pytest (`testing=True`) so CI stays offline.
Object keys match legacy `storage_path`: `documents/{workspace_id}/{file_id}{ext}`.
"""
from __future__ import annotations

from pathlib import Path

import httpx

from app.core.config import ROOT, get_settings
from app.errors import AppError

_LOCAL_ROOT = ROOT / "data"


def object_key(workspace_id: str, filename: str) -> str:
    """Build a storage object key for a new upload."""
    return f"documents/{workspace_id}/{filename}"


def _configured() -> bool:
    settings = get_settings()
    return bool(settings.supabase_url and settings.supabase_service_role_key)


def _use_local() -> bool:
    settings = get_settings()
    if settings.testing:
        return True
    return not _configured()


def _headers(content_type: str | None = None) -> dict[str, str]:
    settings = get_settings()
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "apikey": settings.supabase_service_role_key,
    }
    if content_type:
        headers["Content-Type"] = content_type
        headers["x-upsert"] = "true"
    return headers


def _object_url(key: str) -> str:
    settings = get_settings()
    base = settings.supabase_url.rstrip("/")
    bucket = settings.documents_bucket
    # Storage REST: /storage/v1/object/{bucket}/{path}
    return f"{base}/storage/v1/object/{bucket}/{key}"


def put_bytes(key: str, data: bytes, content_type: str) -> None:
    if not key.startswith("documents/") or ".." in key:
        raise AppError(400, "invalid_storage_key", "Invalid document storage key.")
    if _use_local():
        path = (_LOCAL_ROOT / key).resolve()
        root = (_LOCAL_ROOT / "documents").resolve()
        path.relative_to(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return
    if not _configured():
        raise AppError(
            503,
            "storage_unconfigured",
            "Document storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        )
    url = _object_url(key)
    with httpx.Client(timeout=60.0) as client:
        res = client.post(url, content=data, headers=_headers(content_type))
        if res.status_code not in {200, 201}:
            raise AppError(
                502,
                "storage_upload_failed",
                f"Could not store the file in Supabase Storage ({res.status_code}).",
            )


def get_bytes(key: str) -> bytes | None:
    if not key.startswith("documents/") or ".." in key:
        return None
    if _use_local():
        path = (_LOCAL_ROOT / key).resolve()
        root = (_LOCAL_ROOT / "documents").resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return None
        if not path.is_file():
            return None
        return path.read_bytes()
    if not _configured():
        return None
    url = _object_url(key)
    with httpx.Client(timeout=60.0) as client:
        res = client.get(url, headers=_headers())
        if res.status_code == 404:
            return None
        if res.status_code != 200:
            return None
        return res.content


def delete_bytes(key: str) -> None:
    if not key or ".." in key or not key.startswith("documents/"):
        return
    if _use_local():
        path = (_LOCAL_ROOT / key).resolve()
        root = (_LOCAL_ROOT / "documents").resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return
        if path.is_file():
            path.unlink()
        return
    if not _configured():
        return
    settings = get_settings()
    base = settings.supabase_url.rstrip("/")
    bucket = settings.documents_bucket
    # Prefer single-object delete
    url = f"{base}/storage/v1/object/{bucket}/{key}"
    with httpx.Client(timeout=30.0) as client:
        client.delete(url, headers=_headers())
