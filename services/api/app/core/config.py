import os
from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT / ".env"),
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )

    app_env: str = "development"
    testing: bool = False
    # When true, demo Gmail/Sheets connections work even if APP_ENV=production.
    allow_demo_connections: bool = False
    database_url: str = f"sqlite:///{ROOT / 'data' / 'mailinsider.db'}"
    jwt_secret: str = "dev-only-change-me"
    jwt_expires_days: int = 14
    token_encryption_key: str = ""
    public_api_url: str = "http://localhost:8000"
    # Public HTTPS base for open-tracking pixels (Supabase Edge Function).
    # Falls back to {public_api_url}/t/open when empty (local / pytest).
    public_open_pixel_url: str = ""
    # Optional overrides for recipient-facing document / click links.
    # When empty and SUPABASE_URL is set, defaults to Supabase Edge Functions
    # (works on any device — never embed localhost in outbound mail).
    public_document_url: str = ""  # e.g. https://xxx.supabase.co/functions/v1/view-document
    public_click_url: str = ""  # e.g. https://xxx.supabase.co/functions/v1/track-click
    public_app_url: str = "http://localhost:5173"
    cors_origins: str = "http://localhost:5173"
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:8000/api/v1/integrations/gmail/callback"
    google_sheets_redirect_uri: str = "http://localhost:8000/api/v1/integrations/sheets/callback"
    daily_send_limit: int = 100
    max_recipients: int = 50
    max_upload_bytes: int = 15 * 1024 * 1024
    # Supabase Storage for document bytes (private bucket). Required outside pytest.
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    documents_bucket: str = "documents"
    # AI: prefer local Ollama (default). OpenAI is optional fallback when AI_PROVIDER=auto|openai.
    ai_provider: str = "ollama"  # ollama | openai | auto
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2"
    ollama_embed_model: str = "nomic-embed-text"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    # send + readonly so MailInsider can show recipient replies from the same Gmail thread.
    # userinfo.email identifies the connected account. Reconnect Gmail after changing scopes.
    gmail_send_scope: str = (
        "https://www.googleapis.com/auth/gmail.send "
        "https://www.googleapis.com/auth/gmail.readonly "
        "https://www.googleapis.com/auth/userinfo.email"
    )
    # drive.readonly lists the account's spreadsheets so users can browse and attach any sheet.
    sheets_scope: str = (
        "https://www.googleapis.com/auth/spreadsheets "
        "https://www.googleapis.com/auth/drive.readonly "
        "https://www.googleapis.com/auth/userinfo.email"
    )

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def google_oauth_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def demo_connections_allowed(self) -> bool:
        return (not self.is_production) or self.allow_demo_connections


@lru_cache
def get_settings() -> Settings:
    return Settings()


def resolve_fernet_key() -> str:
    settings = get_settings()
    # Prefer process env so Cloud Run always wins over a baked/local .env.
    key = (os.environ.get("TOKEN_ENCRYPTION_KEY") or settings.token_encryption_key or "").strip()
    if key:
        return key
    if settings.is_production:
        raise RuntimeError("TOKEN_ENCRYPTION_KEY is required when APP_ENV=production")
    path = ROOT / "data" / "dev_fernet.key"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return path.read_text().strip()
    key = Fernet.generate_key().decode()
    path.write_text(key)
    return key
