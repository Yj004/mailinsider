import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings, resolve_fernet_key


def hash_password(password: str) -> str:
    material = hashlib.sha256(password.encode()).hexdigest().encode()
    return bcrypt.hashpw(material, bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    material = hashlib.sha256(password.encode()).hexdigest().encode()
    try:
        return bcrypt.checkpw(material, password_hash.encode())
    except ValueError:
        return False


def create_access_token(user_id: str) -> str:
    settings = get_settings()
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=settings.jwt_expires_days),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> str | None:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    return str(sub) if sub else None


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    return Fernet(resolve_fernet_key().encode()).encrypt(value.encode()).decode()


def decrypt_secret(value: str) -> str:
    if not value:
        return ""
    try:
        return Fernet(resolve_fernet_key().encode()).decrypt(value.encode()).decode()
    except (InvalidToken, ValueError):
        return ""
