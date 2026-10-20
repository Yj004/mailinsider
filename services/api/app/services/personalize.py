"""Template variable substitution for outbound mail."""

from __future__ import annotations

import re

from app.errors import AppError

VAR_PATTERN = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


def merge_fields(
    email: str,
    name: str | None,
    custom: dict | None = None,
) -> dict[str, str]:
    display = (name or "").strip()
    parts = display.split(None, 1) if display else []
    first = parts[0] if parts else ""
    last = parts[1] if len(parts) > 1 else ""
    fields = {
        "email": email,
        "name": display,
        "first_name": first,
        "last_name": last,
        "company": "",
    }
    if custom:
        for key, value in custom.items():
            key_s = str(key).strip()
            if not key_s or not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", key_s):
                continue
            fields[key_s] = "" if value is None else str(value)
    return fields


def find_variables(text: str) -> set[str]:
    return {match.group(1) for match in VAR_PATTERN.finditer(text or "")}


def unresolved_variables(text: str, fields: dict[str, str]) -> list[str]:
    missing = []
    for name in sorted(find_variables(text)):
        if name not in fields or fields[name] is None:
            missing.append(name)
            continue
        # Empty string is allowed for optional fields but flagged when required names
        # are completely absent from the mapping above.
    return missing


def render_text(text: str, fields: dict[str, str], *, strict: bool = False) -> str:
    missing = [name for name in find_variables(text) if name not in fields]
    if strict and missing:
        raise AppError(
            400,
            "unresolved_variables",
            f"Unresolved variables: {', '.join(missing)}. Map them or remove them before sending.",
        )

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in fields:
            return match.group(0) if not strict else ""
        return fields.get(key) or ""

    return VAR_PATTERN.sub(replace, text or "")
