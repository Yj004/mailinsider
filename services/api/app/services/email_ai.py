"""AI email writing helpers for Compose. Never sends mail — drafts only."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from app.services.ai_provider import active_provider, ai_configured, chat_json, require_ai
from app.services.deliverability import analyze_deliverability, rule_rewrite
from app.services.rag import format_rag_for_prompt, retrieve_context
from app.services.signature import DEFAULT_SIGNATURE_TEXT, normalize_signature

TONES = {"professional", "friendly", "casual", "confident", "concise", "persuasive", "follow-up"}
LENGTHS = {"short", "balanced", "detailed"}
ACTIONS = {
    "write",
    "improve",
    "tone",
    "shorten",
    "subject",
    "personalize",
    "reply",
    "refine",
    "grammar",
    "deliverability",
}

# Placeholders that must never appear in drafts (RAG / meta leakage).
_BAD_PLACEHOLDERS = re.compile(
    r"\{\{\s*(sender_knowledge|your_name|my_name|applicant|candidate|rag|knowledge)\s*\}\}",
    re.I,
)
def _draft_payload(subject: str, body: str, *, notes: list[str] | None = None, subjects: list[str] | None = None, engine: str = "ollama") -> dict:
    analysis = analyze_deliverability(subject=subject, body=body)
    return {
        "subject": subject,
        "body_text": body,
        "subject_suggestions": subjects or [],
        "notes": notes or [],
        "engine": engine,
        "analysis": analysis,
    }


def _looks_like_job_application(instruction: str) -> bool:
    text = (instruction or "").lower()
    cues = (
        "apply",
        "application",
        "founding engineer",
        "hiring",
        "job",
        "role",
        "position",
        "open to work",
        "seeking",
        "looking for a",
        "opportunity",
        "recruiter",
        "hiring manager",
    )
    return any(cue in text for cue in cues)


def _extract_target_role(*texts: str) -> str:
    """Pull the exact job title the user asked to apply for from free-text instructions."""
    combined = " ".join(t.strip() for t in texts if (t or "").strip())
    if not combined:
        return ""
    patterns = (
        r"(?i)\bapply(?:ing)?\s+for\s+(?:the\s+)?(.+?)(?:\s+at\s+.+)?\s*$",
        r"(?i)\bapplication\s+for\s+(?:the\s+)?(.+?)(?:\s+at\s+.+)?\s*$",
        r"(?i)\b(?:interest(?:ed)?\s+in|seeking|looking\s+for)\s+(?:the\s+)?(.+?)\s+(?:role|position|job)\b",
        r"(?i)\b(?:role|position|job)\s*[:\-]\s*(.+)$",
    )
    for pat in patterns:
        m = re.search(pat, combined.strip())
        if m:
            role = re.sub(r"\s+", " ", m.group(1)).strip(" .,;:!\"'")
            # Drop trailing fluff like "role" / "position" if the pattern left it
            role = re.sub(r"(?i)\s+(role|position|job|opportunity)\s*$", "", role).strip()
            if 2 <= len(role) <= 120:
                return role
    return ""


def _enforce_role_title(subject: str, body: str, target_role: str) -> tuple[str, str]:
    """If the model drifted to a different title, prefer the user's exact role string."""
    if not target_role:
        return subject, body
    # Common wrong defaults that leak from earlier prompt bias / profile history
    wrong = (
        r"Founding Engineer(?:\s+role|\s+position)?",
        r"founding engineer(?:\s+role|\s+position)?",
    )
    sub, text = subject or "", body or ""
    for pat in wrong:
        if re.search(pat, text) and target_role.lower() not in text.lower():
            text = re.sub(pat, target_role, text)
        if re.search(pat, sub) and target_role.lower() not in sub.lower():
            sub = re.sub(pat, target_role, sub)
    # Ensure opening interest line mentions the target role when body has a generic "the position"
    if target_role.lower() not in text.lower():
        text = re.sub(
            r"(?i)\b(the|a)\s+(Founding Engineer|position|role)\b",
            f"the {target_role}",
            text,
            count=1,
        )
    return sub, text


def _ensure_company_merge(body: str, *, has_recipient_company: bool) -> str:
    """Prefer {{company}} over vague 'your company' / bare role lines when company is unknown."""
    text = body or ""
    if has_recipient_company or "{{company}}" in text:
        return text
    text = re.sub(r"(?i)\byour company\b", "{{company}}", text)
    # "join as a ROLE" / "apply for the ROLE" → add at {{company}} once
    if "{{company}}" not in text:
        text = re.sub(
            r"(?i)(apply(?:ing)? for (?:the )?|join as (?:a |an )?|interest in (?:the )?)([^\n.]{3,80}?)(\s+role|\s+position)?(?=\s*[.,]|\s+at\b|\s*$)",
            lambda m: f"{m.group(1)}{m.group(2)}{m.group(3) or ''} at {{{{company}}}}"
            if " at " not in (m.group(0).lower())
            else m.group(0),
            text,
            count=1,
        )
    return text


def _ensure_signature(body: str, signature: str) -> str:
    """Replace short name-only sign-offs with the full canonical signature block."""
    text = (body or "").rstrip()
    sig = normalize_signature(signature)
    if not sig:
        return text
    # Already has full signature markers
    if "yashjeet.space" in text.lower() and "github.com/yj004" in text.lower():
        return text
    # Strip trailing Best/Regards + name (keep closing word, then attach full sig)
    text = re.sub(
        r"(?is)\n*(best regards|best|regards|thanks|thank you|sincerely),?\s*\n+.*\Z",
        "",
        text,
    ).rstrip()
    return f"{text}\n\nBest regards,\n{sig}"


def _sanitize_draft(
    subject: str,
    body: str,
    *,
    sender_name: str = "",
    signature: str = "",
) -> tuple[str, str]:
    sub = _BAD_PLACEHOLDERS.sub("", subject or "").strip()
    text = _BAD_PLACEHOLDERS.sub("", body or "")
    # Drop accidental meta labels the model sometimes pastes
    text = re.sub(r"\bon\s+\{\{[^}]+\}\}", "", text, flags=re.I)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    sig = normalize_signature(signature, fallback_name=sender_name)
    if sig:
        text = _ensure_signature(text, sig)
    elif sender_name:
        # Replace leftover your_name-style sign-offs if model used plain text
        text = re.sub(
            r"(?im)^(best regards|regards|thanks|thank you|sincerely),?\s*\n+\s*(\{\{[^}]+\}\}|your name|\[your name\])\s*$",
            rf"\1,\n{sender_name}",
            text,
        )
        if not re.search(rf"(?im)^{re.escape(sender_name)}\s*$", text) and re.search(
            r"(?im)^(best regards|regards|thanks|thank you|sincerely),?\s*$", text
        ):
            text = re.sub(
                r"(?im)^(best regards|regards|thanks|thank you|sincerely),?\s*$",
                rf"\1,\n{sender_name}",
                text,
            )
    return sub, text


def _system_prompt(*, job_application: bool, target_role: str = "") -> str:
    base = (
        "You are MailInsider's email writing assistant for professional cold outreach and job applications. "
        "Write plain-text emails only (no HTML). "
        "CRITICAL ROLE: The USER is the SENDER (applicant / outreach author). "
        "Write FROM the sender TO a hiring manager, founder, or recruiter — never the reverse. "
        "Never write as if the company is recruiting the sender. Never praise the sender's resume to them. "
        "ABOUT_THE_SENDER (profile + PDF knowledge) describes the person writing the email — use it for first-person claims only. "
        "RECIPIENT is the person being emailed. Only use recipient fields that are provided; otherwise use {{first_name}} / {{company}}. "
        "Allowed merge fields ONLY: {{first_name}}, {{company}}, {{role}}, {{job_title}}. "
        "Never invent merge fields like {{sender_knowledge}}, {{your_name}}, or {{applicant}}. "
        "Sign off with the sender's real display name when provided — do not use placeholders for the signature. "
        "Never invent employers, degrees, metrics, or skills not present in ABOUT_THE_SENDER. "
        "Use exact employer/company names and metrics as written in ABOUT_THE_SENDER — do not swap or paraphrase employers. "
        "QUALITY BAR: Match a strong Gmail/Gemini application email — concrete stack, outcomes, and ownership. "
        "Avoid vague filler like 'impressed by innovative work', 'passionate', 'significant value', or 'company culture' "
        "unless the recipient context gives a specific company detail. "
        "Prefer calm, specific, human cold email. Avoid spammy urgency, fake Re:/Fwd:, ALL CAPS, and link shorteners. "
        "Return ONLY valid JSON."
    )
    if job_application:
        role_line = (
            f" TARGET_ROLE (mandatory, use this exact title — never substitute another job title such as Founding Engineer): {target_role}."
            if target_role
            else " TARGET_ROLE: Use the exact role title from the user's instruction. Never invent or substitute a different title."
        )
        base += (
            " JOB APPLICATION MODE: Write as the candidate applying for / interested in the role."
            + role_line
            + " DEFAULT STYLE: short and precise — never padded. "
            "Structure: (1) one sentence naming TARGET_ROLE + {{company}}, "
            "(2) one tight sentence with 1–2 strongest ABOUT_THE_SENDER facts relevant to TARGET_ROLE (stack + metric), "
            "(3) one short ask (15-min chat). No bullet lists. No filler. "
            "If no recipient name is known, open with 'Dear Hiring Manager,' instead of a fake name. "
            "You may mention resume only in one brief clause if it fits. "
            "Use exact employer names and metrics from ABOUT_THE_SENDER — never invent. "
            "Skip unknown company-mission lines."
        )
    return base


async def generate_email(
    *,
    action: str,
    instruction: str = "",
    subject: str = "",
    body_text: str = "",
    tone: str = "professional",
    length: str = "balanced",
    refine_instruction: str = "",
    recipient: dict[str, Any] | None = None,
    thread_snippet: str = "",
    db: Session | None = None,
    workspace_id: str | None = None,
) -> dict:
    action = (action or "write").strip().lower()
    if action not in ACTIONS:
        action = "write"
    tone = tone if tone in TONES else "professional"
    # Default to short/precise unless the caller explicitly asks for longer.
    length = length if length in LENGTHS else "short"
    recipient = recipient or {}

    if not ai_configured():
        if action in {"improve", "deliverability", "shorten", "tone", "grammar"}:
            out = rule_rewrite(subject=subject, body=body_text, goal=instruction or refine_instruction or action)
            return out
        require_ai()

    job_application = _looks_like_job_application(instruction) or _looks_like_job_application(refine_instruction)
    target_role = _extract_target_role(instruction, refine_instruction) or str(
        recipient.get("target_role") or recipient.get("job_title") or ""
    ).strip()
    # Always prefer concise drafts for applications unless user explicitly chose detailed.
    if job_application and length == "balanced":
        length = "short"
    length_guide = {
        "short": "Hard cap ~70–90 words. Greeting + 2 short paragraphs + one ask. No bullets, no fluff.",
        "balanced": "About 90–120 words. Greeting, 2 short paragraphs, one ask.",
        "detailed": "About 120–160 words max. Still precise — no filler paragraphs.",
    }[length]

    recipient_bits = {
        "email": recipient.get("email"),
        "name": recipient.get("display_name") or recipient.get("name"),
        "company": recipient.get("company"),
        "job_title": recipient.get("job_title"),
        "target_role": recipient.get("target_role") or target_role or None,
    }
    recipient_bits = {k: v for k, v in recipient_bits.items() if v}

    system = _system_prompt(job_application=job_application, target_role=target_role)

    rag_block = ""
    rag_meta: dict[str, Any] = {}
    sender_name = ""
    sender_signature = DEFAULT_SIGNATURE_TEXT
    if db is not None and workspace_id:
        query = " ".join(
            part
            for part in [
                instruction,
                refine_instruction,
                target_role,
                subject,
                body_text[:500],
                recipient_bits.get("company") or "",
            ]
            if part
        )
        try:
            rag_meta = await retrieve_context(
                db,
                workspace_id,
                query=query,
                limit=5 if job_application else 4,
                prefer_sources=["resume", "chatgpt_summary", "linkedin"] if job_application else None,
            )
            rag_block = format_rag_for_prompt(rag_meta)
            profile = rag_meta.get("profile") or {}
            sender_name = str(profile.get("name") or "").strip()
            sender_signature = normalize_signature(
                profile.get("email_signature"),
                fallback_name=sender_name,
            )
        except Exception:
            rag_meta = {}
            rag_block = ""

    about_sender = {
        "label": "ABOUT_THE_SENDER — facts about the person writing this email (first person). NOT the recipient.",
        "content": rag_block or None,
        "sign_as": sender_signature or sender_name or None,
        "email_signature": sender_signature,
    }

    if action == "write":
        system += ' JSON keys: subject, body_text, subject_suggestions (array of 3 alternate subjects), notes (array).'
        writing_rules = [
            "Open to the recipient: use their name if known, else 'Dear Hiring Manager,' for applications or 'Hi {{first_name}},' for outreach.",
            "Keep it short and precise — every sentence must earn its place.",
            "Lead with the role/interest in one clear sentence.",
            "Include at most 1–2 concrete facts from ABOUT_THE_SENDER — no vague filler.",
            "End with one clear ask, then ABOUT_THE_SENDER.email_signature exactly (full block).",
        ]
        if job_application:
            role_label = target_role or "the exact role named in instruction"
            writing_rules = [
                "SHORT + PRECISE only. Target ~80 words before signature. No bullet lists. No third paragraph of enthusiasm.",
                "Open with 'Dear Hiring Manager,' unless a real recipient name is provided.",
                f"Para 1 (1–2 sentences): apply for '{role_label}' at {{{{company}}}} + 1 strongest relevant proof point "
                "(exact employer, stack, one metric) from ABOUT_THE_SENDER.",
                "Para 2 (1 sentence): 15-minute chat ask. Optional brief resume mention.",
                "Subject: short, names the same TARGET_ROLE — never a different title.",
                "Close with 'Best regards,' then paste ABOUT_THE_SENDER.email_signature verbatim "
                "(name, Portfolio, GitHub, LinkedIn, Mob). No {{your_name}}.",
                "Ban: passion/passionate, cutting-edge, significant impact/value, company culture, "
                "impressed by, particularly drawn to, aligns with my passion, 'notable achievements include'.",
                "Never substitute Founding Engineer or any other title for TARGET_ROLE.",
            ]
        user = {
            "task": "write_new_email",
            "instruction": instruction or "Write a professional outreach email.",
            "TARGET_ROLE": target_role or None,
            "intent": "job_application" if job_application else "outreach",
            "tone": tone if not job_application else "confident",
            "length": length_guide,
            "recipient": recipient_bits
            or {"note": "Unknown recipient — for applications use Dear Hiring Manager; else {{first_name}} / {{company}}."},
            "ABOUT_THE_SENDER": about_sender,
            "example_quality_target": (
                f"Short precise sample shape (do not copy): Dear Hiring Manager, / "
                f"I'm applying for the {target_role or 'stated role'} role at {{{{company}}}}. "
                "With 3+ years building Python/FastAPI backends and GenAI workflows (e.g. Claude/OpenAI) "
                "at [exact employer from knowledge], I'd welcome a 15-minute chat. / Best regards, / "
                "[full email_signature block]. Never change the job title."
                if job_application
                else None
            ),
            "writing_rules": writing_rules,
        }
    elif action == "subject":
        system += " JSON keys: subject (best), subject_suggestions (array of 5), notes (array), body_text (echo input body unchanged)."
        user = {
            "task": "subject_lines",
            "current_subject": subject,
            "body_text": body_text[:4000],
            "tone": tone,
            "recipient": recipient_bits,
            "ABOUT_THE_SENDER": about_sender,
            "intent": "job_application" if job_application else "outreach",
        }
    elif action == "reply":
        system += " JSON keys: subject, body_text, notes (array). Subject should usually keep Re: if appropriate."
        user = {
            "task": "suggest_reply",
            "tone": tone,
            "length": length_guide,
            "thread_snippet": (thread_snippet or "")[:3500],
            "current_draft": body_text[:2000],
            "instruction": instruction or refine_instruction or "Suggest a helpful reply.",
            "ABOUT_THE_SENDER": about_sender,
        }
    elif action == "personalize":
        system += " JSON keys: subject, body_text, notes (array)."
        user = {
            "task": "personalize",
            "subject": subject,
            "body_text": body_text[:5000],
            "recipient": recipient_bits,
            "tone": tone,
            "instruction": instruction or "Personalize using known recipient details without inventing facts.",
            "ABOUT_THE_SENDER": about_sender,
        }
    elif action == "refine":
        system += " JSON keys: subject, body_text, notes (array)."
        user = {
            "task": "refine",
            "subject": subject,
            "body_text": body_text[:5000],
            "refine_instruction": refine_instruction or instruction or "Improve the draft.",
            "tone": tone,
            "length": length_guide,
            "ABOUT_THE_SENDER": about_sender,
            "intent": "job_application" if job_application else "outreach",
        }
    elif action == "grammar":
        system += (
            " JSON keys: subject, body_text, notes (array of fixes applied), "
            "issues (array of {quote, problem, fix})."
        )
        user = {
            "task": "grammar_clarity",
            "subject": subject,
            "body_text": body_text[:5000],
        }
    elif action == "shorten":
        system += " JSON keys: subject, body_text, notes (array)."
        user = {
            "task": "shorten",
            "subject": subject,
            "body_text": body_text[:5000],
            "target": "Reduce length ~30–40% while keeping meaning and one ask.",
            "tone": tone,
            "ABOUT_THE_SENDER": about_sender,
        }
    elif action == "tone":
        system += " JSON keys: subject, body_text, notes (array)."
        user = {
            "task": "change_tone",
            "subject": subject,
            "body_text": body_text[:5000],
            "tone": tone,
            "length": length_guide,
            "ABOUT_THE_SENDER": about_sender,
        }
    elif action == "deliverability":
        system += " JSON keys: subject, body_text, notes (array). Optimize against spam filters while keeping intent."
        user = {
            "task": "deliverability_rewrite",
            "subject": subject,
            "body_text": body_text[:5000],
            "goal": instruction or "Lower spam-trigger risk; keep professional intent.",
            "recipient": recipient_bits,
            "ABOUT_THE_SENDER": about_sender,
        }
    else:  # improve
        system += " JSON keys: subject, body_text, notes (array)."
        user = {
            "task": "improve_draft",
            "subject": subject,
            "body_text": body_text[:5000],
            "tone": tone,
            "length": length_guide,
            "instruction": instruction or "Improve clarity, grammar, and professionalism.",
            "recipient": recipient_bits,
            "ABOUT_THE_SENDER": about_sender,
            "intent": "job_application" if job_application else "outreach",
        }

    if rag_block and isinstance(user, dict) and "ABOUT_THE_SENDER" not in user:
        user["ABOUT_THE_SENDER"] = about_sender

    data = await chat_json(system=system, user=user, temperature=0.25 if job_application else 0.35)
    new_subject = str(data.get("subject") or subject or "").strip()
    new_body = str(data.get("body_text") or body_text or "").strip()
    if action == "subject" and not new_body:
        new_body = body_text
    new_subject, new_body = _sanitize_draft(
        new_subject,
        new_body,
        sender_name=sender_name,
        signature=sender_signature,
    )
    if job_application and target_role:
        new_subject, new_body = _enforce_role_title(new_subject, new_body, target_role)
    if job_application:
        new_body = _ensure_company_merge(
            new_body,
            has_recipient_company=bool(recipient_bits.get("company")),
        )

    notes = data.get("notes") if isinstance(data.get("notes"), list) else []
    suggestions = data.get("subject_suggestions") if isinstance(data.get("subject_suggestions"), list) else []
    issues = data.get("issues") if isinstance(data.get("issues"), list) else []
    note_list = [str(n) for n in notes][:10]
    if rag_meta.get("passages"):
        note_list.append(f"Grounded with AI P&R ({rag_meta.get('method', 'rag')}, {len(rag_meta['passages'])} passages).")
    elif rag_meta.get("profile"):
        note_list.append("Grounded with AI P&R profile parameters.")
    if job_application:
        note_list.append("Framed as applicant → hiring contact (not recruiter → candidate).")
        if target_role:
            note_list.append(f"Locked role title: {target_role}.")
    result = _draft_payload(
        new_subject,
        new_body,
        notes=note_list,
        subjects=[str(s) for s in suggestions if str(s).strip()][:6],
        engine=active_provider() or "ollama",
    )
    if issues:
        result["issues"] = issues[:12]
    return result


async def ai_rewrite(*, subject: str, body: str, goal: str = "", recipient_hint: str = "") -> dict:
    recipient = {"email": recipient_hint} if recipient_hint else {}
    return await generate_email(
        action="deliverability",
        instruction=goal,
        subject=subject,
        body_text=body,
        recipient=recipient,
    )
