import base64
import hashlib
import logging
from email.message import EmailMessage
from email.utils import formataddr
from urllib.parse import urlencode

import httpx

from app.core.config import get_settings
from app.core.security import decrypt_secret
from app.errors import AppError
from app.models import GmailConnection

log = logging.getLogger("mailinsider.gmail")


class TransientSend(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


class PermanentSend(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


class AmbiguousSend(Exception):
    pass


class NeedsReauth(Exception):
    pass


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def authorization_url(
    state: str,
    verifier: str,
    *,
    scope: str | None = None,
    redirect_uri: str | None = None,
) -> str:
    settings = get_settings()
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": redirect_uri or settings.google_redirect_uri,
        "response_type": "code",
        "scope": scope or settings.gmail_send_scope,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "false",
        "state": state,
        "code_challenge": pkce_challenge(verifier),
        "code_challenge_method": "S256",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)


def exchange_code(code: str, verifier: str, *, redirect_uri: str | None = None) -> dict:
    settings = get_settings()
    try:
        response = httpx.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": redirect_uri or settings.google_redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            },
            timeout=20,
        )
    except httpx.HTTPError as exc:
        log.warning("oauth_exchange_failed", extra={"error": type(exc).__name__})
        raise AppError(502, "oauth_failed", "Google did not complete the connection. Try again.") from exc
    if response.status_code >= 400:
        raise AppError(400, "oauth_denied", "Google did not grant access. Nothing was connected.")
    return response.json()


def refresh_access_token(refresh_token: str) -> str:
    settings = get_settings()
    try:
        response = httpx.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise TransientSend("network", "Gmail could not be reached.") from exc
    if response.status_code >= 400:
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if body.get("error") == "invalid_grant":
            raise NeedsReauth()
        raise TransientSend("oauth_refresh", "The Gmail connection could not be refreshed.")
    token = response.json().get("access_token")
    if not token:
        raise NeedsReauth()
    return token


def gmail_profile(access_token: str) -> str:
    # Prefer userinfo.email for the connected account label; thread sync uses gmail.readonly.
    try:
        response = httpx.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "gmail_profile_failed", "Connected, but Google did not return the account address.") from exc
    if response.status_code < 400:
        email = (response.json() or {}).get("email")
        if email:
            return str(email).lower()
    try:
        response = httpx.get(
            "https://gmail.googleapis.com/gmail/v1/users/me/profile",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "gmail_profile_failed", "Connected, but Gmail did not return the account address.") from exc
    if response.status_code >= 400:
        raise AppError(400, "gmail_profile_failed", "Google did not share the account address. Nothing was stored.")
    email = (response.json() or {}).get("emailAddress")
    if not email:
        raise AppError(400, "gmail_profile_failed", "Google did not share the account address. Nothing was stored.")
    return str(email).lower()


def revoke_token(token: str) -> None:
    if not token:
        return
    try:
        httpx.post(
            "https://oauth2.googleapis.com/revoke",
            params={"token": token},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        )
    except httpx.HTTPError:
        log.warning("revoke_failed")


def build_mime(
    *,
    from_name: str,
    from_email: str,
    to_emails: list[str],
    cc_emails: list[str],
    bcc_emails: list[str],
    subject: str,
    text: str,
    html: str,
    pdf_filename: str | None = None,
    pdf_bytes: bytes | None = None,
    message_id: str | None = None,
    in_reply_to: str | None = None,
    references: str | None = None,
) -> bytes:
    message = EmailMessage()
    message["From"] = formataddr((from_name.replace("\n", " ").replace("\r", " "), from_email))
    message["To"] = ", ".join(to_emails)
    if cc_emails:
        message["Cc"] = ", ".join(cc_emails)
    if bcc_emails:
        message["Bcc"] = ", ".join(bcc_emails)
    message["Subject"] = subject.replace("\n", " ").replace("\r", " ")
    if message_id:
        message["Message-ID"] = message_id
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
    if references:
        message["References"] = references
    message.set_content(text or "")
    message.add_alternative(html or "<p></p>", subtype="html")
    if pdf_bytes:
        safe_name = (pdf_filename or "document.pdf").replace("\r", "").replace("\n", "").replace("/", "")
        if not safe_name.lower().endswith(".pdf"):
            safe_name = f"{safe_name}.pdf"
        message.add_attachment(pdf_bytes, maintype="application", subtype="pdf", filename=safe_name[:180])
    return message.as_bytes()


def send_raw(access_token: str, raw: bytes, *, thread_id: str | None = None) -> tuple[str, str | None]:
    """Return (gmail_message_id, gmail_thread_id). Pass thread_id to keep follow-ups in the same Gmail thread."""
    encoded = base64.urlsafe_b64encode(raw).decode()
    body: dict = {"raw": encoded}
    if thread_id:
        body["threadId"] = thread_id
    try:
        response = httpx.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {access_token}"},
            json=body,
            timeout=30,
        )
    except httpx.TimeoutException as exc:
        raise AmbiguousSend() from exc
    except httpx.HTTPError as exc:
        raise TransientSend("network", "Gmail could not be reached. The send was not confirmed.") from exc
    if response.status_code == 401:
        raise NeedsReauth()
    if response.status_code == 429:
        raise TransientSend("rate_limit", "Gmail is rate limiting this account. Wait before sending more.")
    if response.status_code >= 500:
        raise AmbiguousSend()
    if response.status_code >= 400:
        message = _safe_gmail_error(response)
        code = "invalid_recipient" if response.status_code in {400, 404} else "forbidden"
        raise PermanentSend(code, message)
    payload = response.json()
    gmail_id = payload.get("id")
    if not gmail_id:
        raise AmbiguousSend()
    thread_id = payload.get("threadId")
    return str(gmail_id), str(thread_id) if thread_id else None


def _safe_gmail_error(response: httpx.Response) -> str:
    try:
        body = response.json()
        message = ((body.get("error") or {}).get("message")) or "Gmail rejected the message."
    except Exception:
        message = "Gmail rejected the message."
    message = str(message)[:300]
    if "token" in message.lower() or "bearer" in message.lower():
        return "Gmail rejected the message."
    return message


def deliver(
    connection: GmailConnection,
    raw: bytes,
    *,
    thread_id: str | None = None,
) -> tuple[str, str | None, bool]:
    """Return (gmail_message_id, gmail_thread_id, is_demo)."""
    if connection.is_demo:
        from app.models import new_id

        demo_id = f"demo-{new_id()}"
        return demo_id, thread_id or f"demo-thread-{new_id()}", True
    refresh = decrypt_secret(connection.encrypted_refresh_token)
    if not refresh:
        raise NeedsReauth()
    access = refresh_access_token(refresh)
    message_id, out_thread = send_raw(access, raw, thread_id=thread_id)
    return message_id, out_thread or thread_id, False


def _header_map(payload: dict) -> dict[str, str]:
    headers = {}
    for item in ((payload.get("payload") or {}).get("headers") or []):
        name = str(item.get("name") or "").lower()
        if name:
            headers[name] = str(item.get("value") or "")
    return headers


def _decode_body_data(data: str) -> str:
    padded = data + "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode()).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _extract_text_parts(payload: dict) -> tuple[str, str]:
    """Return (text, html) best-effort from a Gmail message payload."""
    text, html = "", ""

    def walk(node: dict) -> None:
        nonlocal text, html
        mime = str(node.get("mimeType") or "")
        body = node.get("body") or {}
        data = body.get("data")
        if data and mime.startswith("text/plain") and not text:
            text = _decode_body_data(str(data))
        if data and mime.startswith("text/html") and not html:
            html = _decode_body_data(str(data))
        for child in node.get("parts") or []:
            walk(child)

    walk(payload.get("payload") or payload)
    return text.strip(), html.strip()


def fetch_thread(connection: GmailConnection, thread_id: str) -> list[dict]:
    """Fetch messages in a Gmail thread. Requires gmail.readonly."""
    if connection.is_demo:
        return []
    refresh = decrypt_secret(connection.encrypted_refresh_token)
    if not refresh:
        raise NeedsReauth()
    access = refresh_access_token(refresh)
    try:
        response = httpx.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/threads/{thread_id}",
            headers={"Authorization": f"Bearer {access}"},
            params={"format": "full"},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        raise TransientSend("network", "Gmail could not be reached.") from exc
    if response.status_code == 401:
        raise NeedsReauth()
    if response.status_code == 403:
        raise PermanentSend(
            "scope_required",
            "Reconnect Gmail and allow mailbox read access so MailInsider can show replies.",
        )
    if response.status_code == 404:
        return []
    if response.status_code >= 400:
        raise TransientSend("gmail_thread", _safe_gmail_error(response))
    messages = []
    for item in (response.json().get("messages") or []):
        headers = _header_map(item)
        text, html = _extract_text_parts(item)
        internal = item.get("internalDate")
        occurred = None
        if internal:
            try:
                from datetime import datetime, timezone

                occurred = datetime.fromtimestamp(int(internal) / 1000, tz=timezone.utc).isoformat()
            except Exception:
                occurred = None
        messages.append(
            {
                "gmail_message_id": str(item.get("id") or ""),
                "gmail_thread_id": str(item.get("threadId") or thread_id),
                "rfc_message_id": headers.get("message-id", ""),
                "from_header": headers.get("from", ""),
                "to_header": headers.get("to", ""),
                "subject": headers.get("subject", ""),
                "snippet": str(item.get("snippet") or ""),
                "body_text": text,
                "body_html": html,
                "occurred_at": occurred,
                "label_ids": item.get("labelIds") or [],
            }
        )
    return messages


def fetch_rfc_message_id(connection: GmailConnection, gmail_message_id: str) -> str | None:
    if connection.is_demo or not gmail_message_id or gmail_message_id.startswith("demo-"):
        return None
    refresh = decrypt_secret(connection.encrypted_refresh_token)
    if not refresh:
        raise NeedsReauth()
    access = refresh_access_token(refresh)
    try:
        response = httpx.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{gmail_message_id}",
            headers={"Authorization": f"Bearer {access}"},
            params={"format": "metadata", "metadataHeaders": ["Message-ID"]},
            timeout=20,
        )
    except httpx.HTTPError:
        return None
    if response.status_code >= 400:
        return None
    headers = _header_map(response.json())
    value = (headers.get("message-id") or "").strip()
    return value or None


def resolve_thread_id(connection: GmailConnection, gmail_message_id: str) -> str | None:
    if connection.is_demo or not gmail_message_id or gmail_message_id.startswith("demo-"):
        return None
    refresh = decrypt_secret(connection.encrypted_refresh_token)
    if not refresh:
        raise NeedsReauth()
    access = refresh_access_token(refresh)
    try:
        response = httpx.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{gmail_message_id}",
            headers={"Authorization": f"Bearer {access}"},
            params={"format": "metadata", "metadataHeaders": "From"},
            timeout=20,
        )
    except httpx.HTTPError:
        return None
    if response.status_code >= 400:
        return None
    thread_id = response.json().get("threadId")
    return str(thread_id) if thread_id else None
