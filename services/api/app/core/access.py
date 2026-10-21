from app.core.config import get_settings
from app.errors import AppError


WAITLIST_MESSAGE = (
    "MailInsider is in private preview. Join the waitlist and we’ll email you when a workspace is available."
)


def public_accounts_open() -> bool:
    settings = get_settings()
    return bool(settings.testing or settings.allow_public_signup)


def operator_email() -> str:
    return (get_settings().owner_email or "work.yashjeet@gmail.com").strip().lower()


def is_operator_email(email: str) -> bool:
    if public_accounts_open():
        return True
    return (email or "").strip().lower() == operator_email()


def require_operator_email(email: str) -> None:
    if is_operator_email(email):
        return
    raise AppError(403, "waitlist_only", WAITLIST_MESSAGE)
