from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class RecipientIn(BaseModel):
    email: str
    name: str | None = None


class TrackingIn(BaseModel):
    open_pixel: bool | None = None
    link_clicks: bool | None = None


class ContactInquiryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=320)
    subject: str = Field(min_length=1, max_length=300)
    message: str = Field(min_length=1, max_length=5000)
    website: str | None = Field(default="", max_length=200)  # honeypot


class RegisterIn(BaseModel):
    email: str
    password: str
    display_name: str = Field(min_length=1, max_length=120)
    workspace_name: str = Field(min_length=2, max_length=80)
    open_tracking_default: bool = True
    link_tracking_default: bool = True


class LoginIn(BaseModel):
    email: str
    password: str


class ForgotIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    token: str
    password: str


class ProfileIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


class DeleteAccountIn(BaseModel):
    password: str
    confirm: str


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    open_tracking_default: bool = True
    link_tracking_default: bool = True


class WorkspacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    open_tracking_default: bool | None = None
    link_tracking_default: bool | None = None
    retention_days: int | None = Field(default=None, ge=30, le=730)


class MemberIn(BaseModel):
    email: str
    role: str

    @field_validator("role")
    @classmethod
    def role_ok(cls, value: str) -> str:
        if value not in {"admin", "member", "viewer"}:
            raise ValueError("Role must be admin, member, or viewer.")
        return value


class MemberPatch(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def role_ok(cls, value: str) -> str:
        if value not in {"owner", "admin", "member", "viewer"}:
            raise ValueError("Role must be owner, admin, member, or viewer.")
        return value


class MessageIn(BaseModel):
    to: list[RecipientIn] = Field(default_factory=list)
    cc: list[RecipientIn] = Field(default_factory=list)
    bcc: list[RecipientIn] = Field(default_factory=list)
    subject: str = ""
    body_text: str = ""
    body_html: str | None = None
    tracking: TrackingIn = Field(default_factory=TrackingIn)
    gmail_connection_id: str | None = None
    document_id: str | None = None
    document_expires_days: int | None = 30
    attach_pdf: bool = False
    include_sheet_link: bool = False
    send: bool = True
    idempotency_key: str | None = Field(default=None, max_length=80)
    workspace_id: str | None = None
    parent_message_id: str | None = None

    @field_validator("subject")
    @classmethod
    def subject_ok(cls, value: str) -> str:
        cleaned = value.strip()
        if "\n" in value or "\r" in value:
            raise ValueError("Subject cannot contain line breaks.")
        if len(cleaned) > 200:
            raise ValueError("Subject must be 200 characters or fewer.")
        return cleaned

    @field_validator("body_text")
    @classmethod
    def body_len(cls, value: str) -> str:
        if len(value) > 100_000:
            raise ValueError("Message body is too long.")
        return value


class ConversationActionIn(BaseModel):
    """Classify what to do after a reply (manual — Gmail read scope is not enabled)."""

    action: str  # continue_3 | wait_7 | end | dead | mark_replied

    @field_validator("action")
    @classmethod
    def action_ok(cls, value: str) -> str:
        allowed = {"continue_3", "wait_7", "end", "dead", "mark_replied"}
        if value not in allowed:
            raise ValueError("action must be continue_3, wait_7, end, dead, or mark_replied.")
        return value


class RetryIn(BaseModel):
    confirm_duplicate: bool = False


class LinkIn(BaseModel):
    expires_in_days: int | None = 30
    message_recipient_id: str | None = None

    @field_validator("expires_in_days")
    @classmethod
    def expiry_ok(cls, value: int | None) -> int | None:
        if value is None:
            return None
        if value < 1 or value > 365:
            raise ValueError("Expiry must be between 1 and 365 days, or empty for no expiry.")
        return value


class RevokeIn(BaseModel):
    token_id: str | None = None


class SheetLinkIn(BaseModel):
    spreadsheet_url: str


class PublicEventIn(BaseModel):
    type: str
    page: int | None = None

    @field_validator("type")
    @classmethod
    def type_ok(cls, value: str) -> str:
        allowed = {"document_view_started", "document_page_viewed", "document_download_requested"}
        if value not in allowed:
            raise ValueError("Unsupported document event.")
        return value


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    subject: str = ""
    body_text: str = ""
    body_html: str | None = None

    @field_validator("subject")
    @classmethod
    def subject_ok(cls, value: str) -> str:
        if "\n" in value or "\r" in value:
            raise ValueError("Subject cannot contain line breaks.")
        if len(value) > 200:
            raise ValueError("Subject must be 200 characters or fewer.")
        return value


class TemplatePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    subject: str | None = None
    body_text: str | None = None
    body_html: str | None = None


class CampaignRecipientPerson(BaseModel):
    email: str
    name: str | None = None
    custom_fields: dict[str, str] = Field(default_factory=dict)


class CampaignIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    subject: str = ""
    body_text: str = ""
    body_html: str | None = None
    template_id: str | None = None
    tracking: TrackingIn = Field(default_factory=TrackingIn)
    gmail_connection_id: str | None = None
    document_id: str | None = None
    attach_pdf: bool = False
    include_sheet_link: bool = False


class CampaignRecipientsIn(BaseModel):
    recipients: list[CampaignRecipientPerson] = Field(default_factory=list)
    contact_ids: list[str] = Field(default_factory=list)


class CampaignLaunchIn(BaseModel):
    confirm_count: int | None = None
    gmail_connection_id: str | None = None


class SheetPreviewIn(BaseModel):
    tab: str | None = None


class SheetImportIn(BaseModel):
    tab: str | None = None
    mapping: dict[str, str]
    dry_run: bool = False


class SuppressionIn(BaseModel):
    email: str
    reason: str = "manual"


PIPELINE_STATUSES = {
    "to_contact",
    "draft",
    "sent",
    "open_detected",
    "link_clicked",
    "replied",
    "follow_up_due",
    "interview",
    "rejected",
    "no_response",
    "closed",
}


class ContactCreateIn(BaseModel):
    email: str
    display_name: str | None = None
    company: str | None = None
    job_title: str | None = None
    linkedin_url: str | None = None
    company_website: str | None = None
    job_posting_url: str | None = None
    target_role: str | None = None
    pipeline_status: str = "to_contact"
    notes: str | None = None
    tags: list[str] = Field(default_factory=list)
    next_follow_up_at: datetime | None = None
    custom_fields: dict[str, str] = Field(default_factory=dict)

    @field_validator("pipeline_status")
    @classmethod
    def _status(cls, value: str) -> str:
        if value not in PIPELINE_STATUSES:
            raise ValueError("Unknown pipeline status.")
        return value

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if "@" not in cleaned or "." not in cleaned.split("@")[-1]:
            raise ValueError("Enter a valid email address.")
        return cleaned


class ContactPatchIn(BaseModel):
    display_name: str | None = None
    company: str | None = None
    job_title: str | None = None
    linkedin_url: str | None = None
    company_website: str | None = None
    job_posting_url: str | None = None
    target_role: str | None = None
    pipeline_status: str | None = None
    notes: str | None = None
    tags: list[str] | None = None
    next_follow_up_at: datetime | None = None
    clear_follow_up: bool = False
    custom_fields: dict[str, str] | None = None

    @field_validator("pipeline_status")
    @classmethod
    def _status(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if value not in PIPELINE_STATUSES:
            raise ValueError("Unknown pipeline status.")
        return value


class ContactBulkDeleteIn(BaseModel):
    contact_ids: list[str] = Field(default_factory=list, max_length=200)
