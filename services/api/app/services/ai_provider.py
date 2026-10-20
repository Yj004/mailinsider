"""Modular AI chat wrapper. Prefers local Ollama; optional OpenAI fallback.

Keys and local endpoints stay server-side. Never log prompts with secrets.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Literal

import httpx

from app.core.config import get_settings
from app.errors import AppError

log = logging.getLogger("mailinsider")

ProviderName = Literal["ollama", "openai"]


def _ollama_base() -> str:
    return (get_settings().ollama_base_url or "http://127.0.0.1:11434").rstrip("/")


def _preferred_provider() -> str:
    raw = (get_settings().ai_provider or "ollama").strip().lower()
    if raw in {"ollama", "openai", "auto"}:
        return raw
    return "ollama"


def ollama_reachable_sync() -> bool:
    try:
        with httpx.Client(timeout=1.5) as client:
            response = client.get(f"{_ollama_base()}/api/tags")
            return response.status_code < 500
    except httpx.HTTPError:
        return False


async def ollama_reachable() -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"{_ollama_base()}/api/tags")
            return response.status_code < 500
    except httpx.HTTPError:
        return False


def ai_configured() -> bool:
    """True if the active provider looks ready (Ollama reachable or OpenAI key set)."""
    return active_provider() is not None


def active_provider() -> ProviderName | None:
    settings = get_settings()
    mode = _preferred_provider()
    if mode == "openai":
        return "openai" if settings.openai_api_key else None
    if mode == "ollama":
        return "ollama" if ollama_reachable_sync() else None
    if ollama_reachable_sync():
        return "ollama"
    if settings.openai_api_key:
        return "openai"
    return None


def require_ai() -> None:
    if active_provider() is None:
        raise AppError(
            503,
            "ai_not_configured",
            "Start Ollama (ollama serve) or set OPENAI_API_KEY, then restart the API.",
        )


def _retry_after_seconds(response: httpx.Response, attempt: int) -> float:
    header = response.headers.get("retry-after")
    if header:
        try:
            return min(20.0, max(1.0, float(header)))
        except ValueError:
            pass
    return min(12.0, 1.5 * (2**attempt))


def _parse_json_content(content: str) -> dict[str, Any]:
    text = (content or "").strip()
    if not text:
        raise AppError(502, "ai_bad_response", "AI returned an empty response.")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Some local models wrap JSON in fences or prose — extract the object.
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise AppError(502, "ai_bad_response", "AI returned an unexpected response.")
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise AppError(502, "ai_bad_response", "AI returned an unexpected response.") from exc
    if not isinstance(data, dict):
        raise AppError(502, "ai_bad_response", "AI returned an unexpected response.")
    return data


async def _chat_ollama(
    *,
    system: str,
    user: str,
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    settings = get_settings()
    model = settings.ollama_model or "llama3.2"
    body = {
        "model": model,
        "stream": False,
        "format": "json",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(f"{_ollama_base()}/api/chat", json=body)
    except httpx.HTTPError as exc:
        raise AppError(
            502,
            "ai_unreachable",
            f"Ollama is not reachable at {_ollama_base()}. Run `ollama serve` and pull the model.",
        ) from exc

    if response.status_code == 404:
        raise AppError(
            502,
            "ai_model_missing",
            f"Ollama model '{model}' not found. Run: ollama pull {model}",
        )
    if response.status_code >= 400:
        detail = ""
        try:
            detail = (response.json().get("error") or "")[:200]
        except Exception:
            detail = (response.text or "")[:200]
        raise AppError(502, "ai_failed", detail or "Ollama request failed.")

    try:
        content = response.json()["message"]["content"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise AppError(502, "ai_bad_response", "Ollama returned an unexpected response.") from exc
    return _parse_json_content(content)


async def _chat_openai(
    *,
    system: str,
    user: str,
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    settings = get_settings()
    if not settings.openai_api_key:
        raise AppError(503, "ai_not_configured", "OPENAI_API_KEY is not set.")
    body = {
        "model": settings.openai_model or "gpt-4o-mini",
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    last_429: httpx.Response | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=50.0) as client:
                response = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers=headers,
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise AppError(502, "ai_unreachable", "The AI service could not be reached. Try again.") from exc

        if response.status_code == 401:
            raise AppError(502, "ai_auth", "OpenAI rejected the API key. Check OPENAI_API_KEY.")
        if response.status_code == 429:
            last_429 = response
            wait = _retry_after_seconds(response, attempt)
            log.warning("openai_rate_limited attempt=%s wait=%.1fs", attempt + 1, wait)
            if attempt < 2:
                await asyncio.sleep(wait)
                continue
            break
        if response.status_code >= 400:
            raise AppError(502, "ai_failed", "AI request failed. Try again in a moment.")

        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise AppError(502, "ai_bad_response", "AI returned an unexpected response.") from exc
        return _parse_json_content(content)

    wait_hint = int(_retry_after_seconds(last_429, 2)) if last_429 is not None else 20
    raise AppError(
        429,
        "ai_rate_limited",
        f"OpenAI rate limit hit. Wait about {wait_hint}s and try again.",
    )


async def chat_json(
    *,
    system: str,
    user: dict[str, Any] | str,
    temperature: float = 0.4,
    max_tokens: int = 1200,
) -> dict[str, Any]:
    require_ai()
    settings = get_settings()
    payload_user = user if isinstance(user, str) else json.dumps(user)
    mode = _preferred_provider()
    provider: ProviderName | None = None
    if mode == "openai":
        provider = "openai"
    elif mode == "ollama":
        provider = "ollama"
    else:
        provider = "ollama" if await ollama_reachable() else ("openai" if settings.openai_api_key else None)

    if provider == "ollama":
        try:
            return await _chat_ollama(
                system=system,
                user=payload_user,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except AppError as exc:
            # auto mode: fall back to OpenAI if Ollama is down and a key exists
            if mode == "auto" and settings.openai_api_key and exc.code in {
                "ai_unreachable",
                "ai_model_missing",
                "ai_failed",
            }:
                log.warning("ollama_failed_fallback_openai code=%s", exc.code)
                return await _chat_openai(
                    system=system,
                    user=payload_user,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            raise

    if provider == "openai":
        return await _chat_openai(
            system=system,
            user=payload_user,
            temperature=temperature,
            max_tokens=max_tokens,
        )

    raise AppError(
        503,
        "ai_not_configured",
        "No AI provider available. Start Ollama or set OPENAI_API_KEY.",
    )


def provider_status() -> dict[str, Any]:
    settings = get_settings()
    provider = active_provider()
    return {
        "configured": provider is not None,
        "provider": provider,
        "ai_provider_setting": _preferred_provider(),
        "ollama_base_url": _ollama_base(),
        "ollama_model": settings.ollama_model or "llama3.2",
        "openai_configured": bool(settings.openai_api_key),
    }
