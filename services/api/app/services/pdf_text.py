"""Extract plain text from PDF bytes for AI P&R RAG indexing."""

from __future__ import annotations

import io
import re

from pypdf import PdfReader

from app.errors import AppError

MAX_CHARS = 200_000


def extract_pdf_text(data: bytes, *, filename: str = "document.pdf") -> str:
    if not data.startswith(b"%PDF"):
        raise AppError(400, "invalid_pdf", f"{filename} is not a valid PDF.")
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise AppError(400, "invalid_pdf", f"Could not read {filename}.") from exc

    parts: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        text = text.strip()
        if text:
            parts.append(text)

    joined = re.sub(r"[ \t]+\n", "\n", "\n\n".join(parts))
    joined = re.sub(r"\n{3,}", "\n\n", joined).strip()
    if len(joined) < 40:
        raise AppError(
            400,
            "empty_pdf_text",
            f"No readable text found in {filename}. Export as a text-based PDF (not a scanned image).",
        )
    if len(joined) > MAX_CHARS:
        joined = joined[:MAX_CHARS]
    return joined
