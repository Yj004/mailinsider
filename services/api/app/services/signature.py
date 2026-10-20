"""Canonical email signature for outbound mail and AI drafts."""

from __future__ import annotations

from html import escape

DEFAULT_SIGNATURE_NAME = "Yashjeet Singh"
DEFAULT_SIGNATURE_TEXT = (
    "Yashjeet Singh\n"
    "Portfolio: https://yashjeet.space\n"
    "GitHub: https://github.com/yj004\n"
    "LinkedIn: https://www.linkedin.com/in/yashjeet-singh/\n"
    "Mob: 9729840783"
)


def normalize_signature(text: str | None, *, fallback_name: str = "") -> str:
    cleaned = (text or "").strip()
    if cleaned:
        return cleaned
    if fallback_name and fallback_name.strip():
        # Keep links even if only name was stored historically.
        name = fallback_name.strip()
        if name.lower() in DEFAULT_SIGNATURE_TEXT.lower():
            return DEFAULT_SIGNATURE_TEXT
        return (
            f"{name}\n"
            "Portfolio: https://yashjeet.space\n"
            "GitHub: https://github.com/yj004\n"
            "LinkedIn: https://www.linkedin.com/in/yashjeet-singh/\n"
            "Mob: 9729840783"
        )
    return DEFAULT_SIGNATURE_TEXT


def signature_already_present(content: str, signature: str | None = None) -> bool:
    """True if the body already includes the signature (avoid double-append on send)."""
    hay = (content or "").lower()
    if not hay:
        return False
    # Strong markers from the canonical block
    markers = ("yashjeet.space", "github.com/yj004", "linkedin.com/in/yashjeet-singh")
    if sum(1 for m in markers if m in hay) >= 2:
        return True
    block = normalize_signature(signature)
    # First line is usually the name — require name + one unique line
    lines = [ln.strip().lower() for ln in block.splitlines() if ln.strip()]
    if len(lines) >= 2 and lines[0] in hay and any(ln in hay for ln in lines[1:3]):
        return True
    return False


def signature_html(text: str | None = None, *, fallback_name: str = "") -> str:
    block = normalize_signature(text, fallback_name=fallback_name)
    lines = [line.strip() for line in block.splitlines() if line.strip()]
    if not lines:
        lines = DEFAULT_SIGNATURE_TEXT.splitlines()
    name = escape(lines[0])
    parts = [f"<p>—</p><p><strong>{name}</strong>"]
    for line in lines[1:]:
        if ":" in line:
            label, _, value = line.partition(":")
            value = value.strip()
            label = escape(label.strip())
            if value.startswith("http://") or value.startswith("https://"):
                parts.append(f'<br>{label}: <a href="{escape(value, quote=True)}">{escape(value)}</a>')
            else:
                parts.append(f"<br>{label}: {escape(value)}")
        else:
            parts.append(f"<br>{escape(line)}")
    parts.append("</p>")
    return "".join(parts)
