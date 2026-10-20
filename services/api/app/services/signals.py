from datetime import datetime, timezone


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


ENGAGEMENT_TYPES = (
    "document_view_started",
    "tracked_link_requested",
    "open_pixel_requested",
)


def counts(event) -> bool:
    return int((event.details or {}).get("counts_toward_metric") or 0) == 1


def automated(event) -> bool:
    return int((event.details or {}).get("possible_automated") or 0) == 1


def recipient_signal(events, recipient_id: str) -> str:
    mine = [event for event in events if event.message_recipient_id == recipient_id and event.event_type in ENGAGEMENT_TYPES]
    if any(event.event_type == "document_view_started" and counts(event) for event in mine):
        return "document_viewed"
    if any(event.event_type == "tracked_link_requested" and counts(event) for event in mine):
        return "link_clicked"
    if any(event.event_type == "open_pixel_requested" and counts(event) for event in mine):
        return "open_detected"
    if mine:
        return "possible_automated"
    return "no_activity"


PUBLIC_META_KEYS = {
    "page",
    "error_code",
    "demo",
    "permanent",
    "filename",
    "destination_host",
    "destination_url",
    "confidence",
    "inferred_from",
}


def public_details(details: dict | None) -> dict:
    source = details or {}
    return {key: source[key] for key in PUBLIC_META_KEYS if key in source}
