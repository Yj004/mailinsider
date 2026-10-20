"""Lightweight RAG over workspace AI P&R profile + knowledge docs.

Uses Ollama embeddings when available; hybrid lexical overlap for exact-name accuracy.
"""

from __future__ import annotations

import math
import re
from typing import Any

import httpx
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import AiKnowledgeChunk, AiKnowledgeDoc, AiProfile

_TOKEN = re.compile(r"[a-z0-9]{2,}", re.I)
_PHRASE = re.compile(r"[a-z0-9][a-z0-9 &\-/.]{2,}", re.I)

# Per-source caps so the large ChatGPT PDF cannot drown resume/LinkedIn hits.
_SOURCE_CAP = {
    "resume": 3,
    "linkedin": 2,
    "chatgpt_summary": 1,
}
_DEFAULT_SOURCE_CAP = 2


def _tokens(text: str) -> set[str]:
    return {m.group(0).lower() for m in _TOKEN.finditer(text or "")}


def chunk_text(text: str, *, size: int = 900, overlap: int = 120) -> list[str]:
    cleaned = re.sub(r"\r\n?", "\n", text or "").strip()
    if not cleaned:
        return []
    if len(cleaned) <= size:
        return [cleaned]
    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        end = min(len(cleaned), start + size)
        piece = cleaned[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= len(cleaned):
            break
        start = max(end - overlap, start + 1)
    return chunks


async def embed_texts(texts: list[str]) -> list[list[float]] | None:
    if not texts:
        return []
    settings = get_settings()
    base = (settings.ollama_base_url or "http://127.0.0.1:11434").rstrip("/")
    model = settings.ollama_embed_model or "nomic-embed-text"
    vectors: list[list[float]] = []
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            for text in texts:
                response = await client.post(
                    f"{base}/api/embeddings",
                    json={"model": model, "prompt": text[:8000]},
                )
                if response.status_code >= 400:
                    return None
                emb = response.json().get("embedding")
                if not isinstance(emb, list) or not emb:
                    return None
                vectors.append([float(x) for x in emb])
    except httpx.HTTPError:
        return None
    return vectors


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def lexical_score(query: str, body: str) -> float:
    qt = _tokens(query)
    bt = _tokens(body)
    if not qt or not bt:
        return 0.0
    overlap = len(qt & bt)
    return overlap / math.sqrt(len(qt) * len(bt))


def _phrase_boost(query: str, body: str) -> float:
    """Reward exact multi-word / proper-noun hits the embedder often under-ranks."""
    q = (query or "").lower().strip()
    b = (body or "").lower()
    if not q or not b:
        return 0.0
    boost = 0.0
    # Full query as phrase
    if len(q) >= 4 and q in b:
        boost += 0.35
    # Significant tokens / short phrases (employer names, role titles)
    for match in _PHRASE.finditer(q):
        phrase = match.group(0).strip().lower()
        if len(phrase) < 4:
            continue
        if phrase in b:
            boost += 0.12 if " " in phrase or "-" in phrase else 0.06
    # Topic aliases: Gen AI ↔ GenAI / LLM stacks
    topic_groups = (
        ("gen ai", "genai", "llm", "claude", "openai"),
        ("fastapi", "fast api"),
        ("software engineer", "backend engineer", "founding engineer"),
    )
    for group in topic_groups:
        if any(term in q for term in group) and any(term in b for term in group):
            boost += 0.14
    return min(boost, 0.65)


def _education_penalty(body: str) -> float:
    """Down-rank pure education/contact blobs when experience passages exist."""
    b = (body or "").lower()
    edu = bool(re.search(r"\b(b\.?tech|university|gpa|masai|bachelor)\b", b))
    work = bool(re.search(r"\b(fastapi|events/?day|senior|engineer at|pvt\.?\s*ltd|built|developed)\b", b))
    if edu and not work:
        return 0.82
    return 1.0


def _looks_like_job_query(query: str) -> bool:
    text = (query or "").lower()
    cues = ("apply", "application", "hiring", "role", "position", "job", "engineer", "developer", "recruiter")
    return any(c in text for c in cues)


def get_or_create_profile(db: Session, workspace_id: str) -> AiProfile:
    row = db.query(AiProfile).filter(AiProfile.workspace_id == workspace_id).one_or_none()
    if row:
        return row
    row = AiProfile(workspace_id=workspace_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def profile_payload(row: AiProfile) -> dict[str, Any]:
    from app.services.signature import normalize_signature

    return {
        "id": row.id,
        "display_name": row.display_name or "",
        "headline": row.headline or "",
        "summary": row.summary or "",
        "skills": row.skills or "",
        "looking_for": row.looking_for or "",
        "target_roles": row.target_roles or "",
        "target_companies": row.target_companies or "",
        "location_pref": row.location_pref or "",
        "regulations": row.regulations or "",
        "tone_rules": row.tone_rules or "",
        "do_not_claim": row.do_not_claim or "",
        "email_signature": normalize_signature(
            getattr(row, "email_signature", None),
            fallback_name=row.display_name or "",
        ),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def index_document(db: Session, doc: AiKnowledgeDoc) -> int:
    db.query(AiKnowledgeChunk).filter(AiKnowledgeChunk.document_id == doc.id).delete()
    pieces = chunk_text(doc.content_text)
    vectors = await embed_texts(pieces)
    for index, piece in enumerate(pieces):
        emb = vectors[index] if vectors and index < len(vectors) else None
        db.add(
            AiKnowledgeChunk(
                workspace_id=doc.workspace_id,
                document_id=doc.id,
                chunk_index=index,
                content=piece,
                embedding=emb,
            )
        )
    doc.chunk_count = len(pieces)
    db.commit()
    return len(pieces)


async def retrieve_context(
    db: Session,
    workspace_id: str,
    *,
    query: str,
    limit: int = 5,
    prefer_sources: list[str] | None = None,
) -> dict[str, Any]:
    profile = get_or_create_profile(db, workspace_id)
    from app.services.signature import normalize_signature

    profile_bits = {
        "name": profile.display_name,
        "headline": profile.headline,
        "summary": profile.summary,
        "skills": profile.skills,
        "looking_for": profile.looking_for,
        "target_roles": profile.target_roles,
        "target_companies": profile.target_companies,
        "location": profile.location_pref,
        "regulations": profile.regulations,
        "tone_rules": profile.tone_rules,
        "do_not_claim": profile.do_not_claim,
        "email_signature": normalize_signature(
            getattr(profile, "email_signature", None),
            fallback_name=profile.display_name or "",
        ),
    }
    profile_bits = {k: v for k, v in profile_bits.items() if (v or "").strip()}

    chunks = (
        db.query(AiKnowledgeChunk)
        .filter(AiKnowledgeChunk.workspace_id == workspace_id)
        .order_by(AiKnowledgeChunk.created_at.desc())
        .limit(500)
        .all()
    )
    if not chunks:
        return {
            "profile": profile_bits,
            "passages": [],
            "method": "profile_only",
            "query": (query or "").strip(),
            "stats": {"chunks_scanned": 0, "with_embedding": 0},
        }

    docs = {
        row.id: row
        for row in db.query(AiKnowledgeDoc).filter(AiKnowledgeDoc.workspace_id == workspace_id).all()
    }

    # Auto-prefer career PDFs for application-style queries (same as Compose).
    if prefer_sources is None and _looks_like_job_query(query):
        prefer_sources = ["resume", "chatgpt_summary", "linkedin"]
    prefer = {s.lower() for s in (prefer_sources or [])}

    q = (query or "").strip() or " ".join(str(v) for v in profile_bits.values())
    # Embed the user's query as-is — do not inject fixed stack/title keywords (that biased hits).
    q_emb_list = await embed_texts([q])
    q_emb = q_emb_list[0] if q_emb_list else None
    with_emb = sum(1 for c in chunks if isinstance(c.embedding, list) and c.embedding)
    method = "hybrid" if q_emb else "lexical"

    scored: list[tuple[float, float, float, float, AiKnowledgeChunk]] = []
    for chunk in chunks:
        lex = lexical_score(q, chunk.content)
        phrase = _phrase_boost(q, chunk.content)
        if q_emb and isinstance(chunk.embedding, list) and chunk.embedding:
            emb = _cosine(q_emb, chunk.embedding)
            # Hybrid: semantic recall + lexical/phrase precision for names & titles.
            score = 0.58 * emb + 0.27 * lex + phrase
        else:
            emb = 0.0
            score = 0.7 * lex + phrase
        score *= _education_penalty(chunk.content)
        doc = docs.get(chunk.document_id)
        src = (doc.source if doc else "") or ""
        if src in prefer:
            # Resume first for applications — chatgpt_summary is large/noisy.
            if src == "resume":
                score *= 1.22
            elif src == "linkedin":
                score *= 1.12
            elif src == "chatgpt_summary":
                score *= 1.05
        if score > 0.02:
            scored.append((score, emb, lex, phrase, chunk))
    scored.sort(key=lambda item: item[0], reverse=True)

    limit_n = max(1, min(limit, 10))
    top: list[tuple[float, float, float, float, AiKnowledgeChunk]] = []
    source_counts: dict[str, int] = {}

    def _cap_for(src: str) -> int:
        return _SOURCE_CAP.get(src, _DEFAULT_SOURCE_CAP)

    for item in scored:
        if len(top) >= limit_n:
            break
        chunk = item[4]
        src = (docs.get(chunk.document_id).source if docs.get(chunk.document_id) else "") or ""
        if source_counts.get(src, 0) >= _cap_for(src):
            continue
        # Near-duplicate skip: same first 80 chars already taken
        preview = (chunk.content or "")[:80].lower()
        if any((c.content or "")[:80].lower() == preview for *_, c in top):
            continue
        top.append(item)
        source_counts[src] = source_counts.get(src, 0) + 1

    # Ensure at least one hit from each preferred source when available.
    for pref in prefer:
        if source_counts.get(pref, 0) > 0:
            continue
        for item in scored:
            chunk = item[4]
            doc = docs.get(chunk.document_id)
            if doc and doc.source == pref and item not in top:
                if len(top) >= limit_n:
                    # Replace weakest chatgpt_summary / lowest score if needed
                    top.sort(key=lambda x: x[0])
                    top[0] = item
                else:
                    top.append(item)
                source_counts[pref] = source_counts.get(pref, 0) + 1
                break

    top = sorted(top, key=lambda item: item[0], reverse=True)[:limit_n]

    passages = [
        {
            "score": round(score, 4),
            "embedding_score": round(emb, 4),
            "lexical_score": round(lex, 4),
            "phrase_boost": round(phrase, 4),
            "title": (docs.get(chunk.document_id).title if docs.get(chunk.document_id) else "Knowledge"),
            "source": (docs.get(chunk.document_id).source if docs.get(chunk.document_id) else ""),
            "content": chunk.content[:1400],
        }
        for score, emb, lex, phrase, chunk in top
    ]
    return {
        "profile": profile_bits,
        "passages": passages,
        "method": method,
        "query": q,
        "prefer_sources": sorted(prefer) if prefer else [],
        "stats": {
            "chunks_scanned": len(chunks),
            "with_embedding": with_emb,
            "returned": len(passages),
        },
    }


def format_rag_for_prompt(context: dict[str, Any]) -> str:
    parts: list[str] = [
        "ABOUT THE SENDER (the person writing this email — use in FIRST PERSON).",
        "Do NOT treat this as the recipient's bio. Do NOT write as a recruiter hiring this person.",
        "Only cite facts present below. Prefer resume/LinkedIn metrics over vague summary marketing lines.",
    ]
    profile = context.get("profile") or {}
    if profile:
        parts.append("Sender profile / parameters:")
        for key, value in profile.items():
            parts.append(f"- {key}: {value}")
    passages = context.get("passages") or []
    if passages:
        parts.append("Retrieved facts from the sender's LinkedIn / resume / career PDFs (cite only these):")
        for index, item in enumerate(passages, 1):
            src = item.get("source") or "knowledge"
            title = item.get("title") or "Knowledge"
            score = item.get("score")
            score_bit = f" score={score}" if score is not None else ""
            parts.append(f"[{index}] ({src} · {title}{score_bit}) {item.get('content')}")
    return "\n".join(parts)[:6000]
