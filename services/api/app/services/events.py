from datetime import timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models import Message, MessageRecipient, TrackingEvent, utcnow

# Tag Gmail/Yahoo image proxies in metadata (still count as opens — pixel load = open).
PROXY_UA_MARKERS = (
    "googleimageproxy",
    "ggpht.com",
    "google-proxy",
    "yahoo mail proxy",
    "yahoomailproxy",
)


def is_proxy_user_agent(user_agent: str | None) -> bool:
    ua = (user_agent or "").lower()
    return any(marker in ua for marker in PROXY_UA_MARKERS)


def record_event(
    db: Session,
    *,
    workspace_id: str,
    event_type: str,
    source: str,
    message_id: str | None = None,
    message_recipient_id: str | None = None,
    document_id: str | None = None,
    details: dict | None = None,
    idempotency_key: str | None = None,
    burst: bool = False,
) -> TrackingEvent | None:
    if idempotency_key:
        existing = (
            db.query(TrackingEvent)
            .filter(TrackingEvent.source == source, TrackingEvent.idempotency_key == idempotency_key)
            .one_or_none()
        )
        if existing:
            return existing
    payload = dict(details or {})
    payload.setdefault("counts_toward_metric", 1)
    payload.setdefault("possible_automated", 0)
    event = TrackingEvent(
        workspace_id=workspace_id,
        message_id=message_id,
        message_recipient_id=message_recipient_id,
        document_id=document_id,
        event_type=event_type,
        source=source,
        idempotency_key=idempotency_key,
        details=payload,
    )
    try:
        with db.begin_nested():
            db.add(event)
            db.flush()
    except IntegrityError:
        if not idempotency_key:
            raise
        return (
            db.query(TrackingEvent)
            .filter(TrackingEvent.source == source, TrackingEvent.idempotency_key == idempotency_key)
            .one_or_none()
        )
    if burst and message_recipient_id:
        _flag_burst(db, message_recipient_id, event_type)
    if event_type == "open_pixel_requested" and message_recipient_id and message_id:
        _dedupe_cross_message_opens(db, workspace_id, message_recipient_id)
    return event


def record_open_pixel_hit(
    db: Session,
    *,
    workspace_id: str,
    message_id: str,
    message_recipient_id: str,
    token_hash: str,
    user_agent: str | None = None,
    client_ip: str | None = None,
    method: str = "GET",
) -> TrackingEvent | None:
    """Pixel GET → store in DB and count as Opened. No grace window."""
    method_u = (method or "GET").upper()
    if method_u == "HEAD":
        return None

    idem = f"open-pixel:{token_hash}"
    existing = (
        db.query(TrackingEvent)
        .filter(TrackingEvent.source == "tracking_pixel", TrackingEvent.idempotency_key == idem)
        .one_or_none()
    )
    now = utcnow()
    proxy = 1 if is_proxy_user_agent(user_agent) else 0

    if existing is not None:
        details = dict(existing.details or {})
        details["hit_count"] = int(details.get("hit_count") or 1) + 1
        details["last_hit_at"] = now.isoformat()
        details["counts_toward_metric"] = 1
        details["possible_automated"] = 0
        if user_agent:
            details["user_agent"] = str(user_agent)[:240]
            details["proxy_ua"] = proxy
        if client_ip:
            details["client_ip"] = str(client_ip)[:64]
        existing.details = details
        flag_modified(existing, "details")
        _dedupe_cross_message_opens(db, workspace_id, message_recipient_id)
        return existing

    details = {
        "counts_toward_metric": 1,
        "possible_automated": 0,
        "proxy_ua": proxy,
        "hit_count": 1,
        "first_hit_at": now.isoformat(),
        "last_hit_at": now.isoformat(),
        "http_method": method_u,
    }
    if user_agent:
        details["user_agent"] = str(user_agent)[:240]
    if client_ip:
        details["client_ip"] = str(client_ip)[:64]

    return record_event(
        db,
        workspace_id=workspace_id,
        message_id=message_id,
        message_recipient_id=message_recipient_id,
        event_type="open_pixel_requested",
        source="tracking_pixel",
        burst=True,
        idempotency_key=idem,
        details=details,
    )


def maybe_infer_open(
    db: Session,
    *,
    workspace_id: str,
    message_id: str | None,
    message_recipient_id: str | None,
    inferred_from: str,
) -> TrackingEvent | None:
    """Count an open when a link click / document view proves the mail was seen."""
    if not message_recipient_id or not message_id:
        return None
    existing = (
        db.query(TrackingEvent)
        .filter(
            TrackingEvent.message_recipient_id == message_recipient_id,
            TrackingEvent.event_type == "open_pixel_requested",
        )
        .order_by(TrackingEvent.occurred_at.asc())
        .first()
    )
    if existing is not None:
        details = dict(existing.details or {})
        if int(details.get("counts_toward_metric") or 0) != 1:
            details["counts_toward_metric"] = 1
            details["possible_automated"] = 0
            details["promoted_at"] = utcnow().isoformat()
            details["promoted_from"] = inferred_from
            details["confidence"] = "estimated"
            details["inferred_from"] = inferred_from
            existing.details = details
            flag_modified(existing, "details")
        return existing
    return record_event(
        db,
        workspace_id=workspace_id,
        message_id=message_id,
        message_recipient_id=message_recipient_id,
        event_type="open_pixel_requested",
        source="inferred",
        details={
            "confidence": "estimated",
            "inferred_from": inferred_from,
            "counts_toward_metric": 1,
            "hit_count": 0,
        },
        idempotency_key=f"inferred-open:{message_recipient_id}",
    )


def _flag_burst(db: Session, recipient_id: str, event_type: str) -> None:
    since = utcnow() - timedelta(seconds=15)
    recent = (
        db.query(TrackingEvent)
        .filter(
            TrackingEvent.message_recipient_id == recipient_id,
            TrackingEvent.event_type == event_type,
            TrackingEvent.occurred_at >= since,
        )
        .all()
    )
    if len(recent) < 3:
        return
    for event in recent:
        details = dict(event.details or {})
        details["counts_toward_metric"] = 0
        details["possible_automated"] = 1
        event.details = details
        flag_modified(event, "details")


def _dedupe_cross_message_opens(db: Session, workspace_id: str, message_recipient_id: str) -> None:
    """If the same address gets opens on 2+ messages within 45s, keep the newest send."""
    recipient = db.get(MessageRecipient, message_recipient_id)
    if recipient is None or not recipient.email_snapshot:
        return
    since = utcnow() - timedelta(seconds=45)
    peer_ids = [
        row[0]
        for row in db.query(MessageRecipient.id)
        .filter(
            MessageRecipient.workspace_id == workspace_id,
            MessageRecipient.recipient_type == "to",
            MessageRecipient.email_snapshot == recipient.email_snapshot,
        )
        .all()
    ]
    if not peer_ids:
        return
    recent = (
        db.query(TrackingEvent)
        .filter(
            TrackingEvent.workspace_id == workspace_id,
            TrackingEvent.event_type == "open_pixel_requested",
            TrackingEvent.message_recipient_id.in_(peer_ids),
            TrackingEvent.occurred_at >= since,
        )
        .all()
    )
    counted = [event for event in recent if int((event.details or {}).get("counts_toward_metric") or 0) == 1]
    message_ids = {event.message_id for event in counted if event.message_id}
    if len(message_ids) < 2:
        return
    messages = db.query(Message).filter(Message.id.in_(message_ids)).all()
    if not messages:
        return
    winner = max(messages, key=lambda item: item.sent_at or item.created_at)
    for event in counted:
        details = dict(event.details or {})
        if event.message_id == winner.id:
            details["counts_toward_metric"] = 1
            details["possible_automated"] = 0
            details.pop("prefetch_suppressed", None)
        else:
            details["counts_toward_metric"] = 0
            details["possible_automated"] = 1
            details["prefetch_suppressed"] = 1
        event.details = details
        flag_modified(event, "details")


def audit(
    db: Session,
    *,
    workspace_id: str,
    actor_user_id: str | None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    details: dict | None = None,
) -> None:
    from app.models import AuditLog

    db.add(
        AuditLog(
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or {},
        )
    )
