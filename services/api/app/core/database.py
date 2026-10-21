from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


def _make_engine():
    url = get_settings().database_url
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, connect_args=connect_args, pool_pre_ping=True)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _fk(dbapi_connection, _record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from app import models  # noqa: F401

    settings = get_settings()
    if settings.database_url.startswith("sqlite"):
        path = settings.database_url.replace("sqlite:///", "")
        if path and path != ":memory:":
            from pathlib import Path

            Path(path).parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    _ensure_sqlite_columns()
    _ensure_postgres_columns()


def _ensure_sqlite_columns() -> None:
    settings = get_settings()
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    additions = {
        "oauth_states": {
            "purpose": "VARCHAR(20) DEFAULT 'gmail'",
            "spreadsheet_url": "TEXT",
        },
        "messages": {
            "attach_pdf": "BOOLEAN DEFAULT 0",
            "include_sheet_link": "BOOLEAN DEFAULT 0",
            "include_signature": "BOOLEAN DEFAULT 1",
            "signature_text": "TEXT DEFAULT ''",
            "campaign_id": "VARCHAR(36)",
            "template_id": "VARCHAR(36)",
            "parent_message_id": "VARCHAR(36)",
            "follow_up_count": "INTEGER DEFAULT 0",
            "follow_up_index": "INTEGER DEFAULT 0",
            "next_follow_up_at": "DATETIME",
            "conversation_status": "VARCHAR(32) DEFAULT 'active'",
            "gmail_thread_id": "VARCHAR(128)",
            "rfc_message_id": "VARCHAR(320)",
            "hidden_at": "DATETIME",
        },
        "message_replies": {
            "rfc_message_id": "VARCHAR(320)",
        },
        "contacts": {
            "custom_fields": "TEXT DEFAULT '{}'",
            "source": "VARCHAR(40)",
            "updated_at": "DATETIME",
            "company": "VARCHAR(160)",
            "job_title": "VARCHAR(160)",
            "linkedin_url": "TEXT",
            "company_website": "TEXT",
            "job_posting_url": "TEXT",
            "target_role": "VARCHAR(160)",
            "pipeline_status": "VARCHAR(40) DEFAULT 'to_contact'",
            "notes": "TEXT",
            "tags": "TEXT DEFAULT '[]'",
            "last_contacted_at": "DATETIME",
            "next_follow_up_at": "DATETIME",
        },
        "ai_profiles": {
            "email_signature": "TEXT DEFAULT ''",
        },
    }
    with engine.begin() as connection:
        for table, columns in additions.items():
            existing = {row[1] for row in connection.execute(text(f"PRAGMA table_info({table})"))}
            if not existing:
                continue
            for name, declaration in columns.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}"))


def _ensure_postgres_columns() -> None:
    settings = get_settings()
    if not settings.database_url.startswith("postgresql"):
        return
    from sqlalchemy import text

    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE ai_profiles ADD COLUMN IF NOT EXISTS email_signature TEXT DEFAULT ''"
            )
        )
        connection.execute(
            text(
                """
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_at timestamptz
                """
            )
        )
        connection.execute(
            text(
                """
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS include_signature BOOLEAN DEFAULT true
                """
            )
        )
        connection.execute(
            text(
                """
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS signature_text TEXT DEFAULT ''
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS waitlist_signups (
                  id text PRIMARY KEY,
                  name varchar(200) NOT NULL,
                  company_name varchar(200),
                  email varchar(320) NOT NULL UNIQUE,
                  monthly_sends integer NOT NULL,
                  willing_to_pay varchar(80) NOT NULL,
                  created_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
        )
