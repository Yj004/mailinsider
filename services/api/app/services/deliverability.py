"""Content spam-risk analysis + optional DNS auth lookups.

Content scores estimate risk from the draft text. SPF/DKIM/DMARC are shown only
when TXT records can be verified. Inbox placement cannot be predicted from text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from app.services.ai_provider import ai_configured

# High-signal promotional patterns (not single common words alone).
SPAMMY_PHRASES = [
    (r"\bact now\b", "Urgent CTA phrasing"),
    (r"\bact immediately\b", "Urgent CTA phrasing"),
    (r"\blimited[- ]time offer\b", "Scarcity / promo offer language"),
    (r"\bmake money\b", "Get-rich promotional language"),
    (r"\bwork from home\b", "Classic spam vertical phrasing"),
    (r"\bdouble your\b", "Exaggerated promise"),
    (r"\b100%\s*(free|guaranteed)\b", "Absolute marketing claim"),
    (r"\brisk[- ]free\b", "Marketing guarantee language"),
    (r"\bno obligation\b", "Promo / telemarketing phrasing"),
    (r"\bfree money\b", "Promo claim"),
    (r"\b\$\$\$+\b", "Money symbol spam pattern"),
    (r"\bclick here\b", "Generic link CTA"),
    (r"\bbuy now\b", "Hard-sell CTA"),
    (r"\border now\b", "Hard-sell CTA"),
    (r"\bthis is not spam\b", "Self-denial phrase filters often flag"),
    (r"\bdear friend\b", "Impersonal mass-mail greeting"),
    (r"\bcongratulations[,!]?\s+you\b", "Prize / lottery pattern"),
]

SHORTENER_HOSTS = (
    "bit.ly",
    "t.co",
    "goo.gl",
    "tinyurl.com",
    "ow.ly",
    "buff.ly",
    "cutt.ly",
    "rebrand.ly",
)


@dataclass
class Finding:
    code: str
    severity: str  # high | medium | low
    category: str  # content | personalization | subject | technical | attachment
    message: str
    evidence: str
    suggestion: str


def _findings_payload(findings: list[Finding]) -> list[dict]:
    return [
        {
            "code": f.code,
            "severity": f.severity,
            "category": f.category,
            "message": f.message,
            "evidence": f.evidence,
            "suggestion": f.suggestion,
        }
        for f in findings
    ]


def analyze_deliverability(
    *,
    subject: str,
    body: str,
    has_attachment: bool = False,
    attachment_name: str | None = None,
) -> dict:
    subject = (subject or "").strip()
    body = (body or "").strip()
    combined = f"{subject}\n{body}"
    findings: list[Finding] = []
    content_penalty = 0
    writing_penalty = 0
    subject_penalty = 0
    personalization_penalty = 0

    def add(
        points: int,
        bucket: str,
        code: str,
        severity: str,
        category: str,
        message: str,
        evidence: str,
        suggestion: str,
    ) -> None:
        nonlocal content_penalty, writing_penalty, subject_penalty, personalization_penalty
        if bucket == "content":
            content_penalty += points
        elif bucket == "writing":
            writing_penalty += points
        elif bucket == "subject":
            subject_penalty += points
        elif bucket == "personalization":
            personalization_penalty += points
        findings.append(Finding(code, severity, category, message, evidence, suggestion))

    # —— Subject ——
    if not subject:
        add(25, "subject", "empty_subject", "high", "subject", "Missing subject line.", "Subject field is empty.", "Add a specific subject (about 6–12 words).")
    else:
        if len(subject) > 70:
            add(10, "subject", "subject_long", "medium", "subject", "Subject is long for mobile preview.", f"{len(subject)} characters.", "Keep the key point in the first ~50 characters.")
        if subject.isupper() and len(subject) > 4:
            add(18, "subject", "subject_caps", "high", "subject", "Subject is all caps.", subject[:80], "Use sentence case.")
        if subject.count("!") >= 2 or "!!!" in subject:
            add(14, "subject", "subject_exclaim", "high", "subject", "Heavy punctuation in the subject.", subject[:80], "Remove extra exclamation marks.")
        if re.match(r"^(re|fwd)\s*:", subject, re.I):
            add(20, "subject", "fake_thread", "high", "subject", "Looks like a reply/forward on what may be first contact.", subject[:80], "Don't fake a thread — filters and recipients both distrust it.")
        if re.search(r"\bfree\b.*\b(now|gift|money)\b|\b(winner|congratulations)\b", subject, re.I):
            add(12, "subject", "subject_promo", "medium", "subject", "Subject reads promotional.", subject[:80], "Lead with relevance to the recipient, not a giveaway tone.")

    # —— Body ——
    if not body:
        add(25, "writing", "empty_body", "high", "content", "Message body is empty.", "Body field is empty.", "Write a short personal note with one clear ask.")
    else:
        words = re.findall(r"[A-Za-z']+", body)
        if len(words) < 18:
            add(8, "writing", "body_short", "medium", "content", "Body is very short.", f"{len(words)} words.", "Add one sentence of context.")
        if len(words) > 350:
            add(10, "writing", "body_long", "medium", "content", "Body is long for cold email.", f"{len(words)} words.", "Aim for roughly 80–150 words and one ask.")
        letters = [c for c in body if c.isalpha()]
        if letters:
            caps_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
            if caps_ratio > 0.35 and len(letters) > 40:
                add(14, "writing", "body_caps", "high", "content", "Excessive capitalization.", f"~{int(caps_ratio * 100)}% uppercase letters.", "Use normal sentence case.")
        if body.count("!") >= 3:
            add(8, "writing", "body_exclaim", "medium", "content", "Many exclamation marks.", f"{body.count('!')} exclamation marks.", "Calm the tone; filters treat hype poorly.")

        # Personalization signals (heuristic)
        has_merge = bool(re.search(r"\{\{[a-z_]+\}\}", body, re.I))
        has_name_greeting = bool(re.search(r"\b(hi|hello|dear)\s+[A-Z][a-z]+", body))
        generic_open = bool(re.search(r"\b(dear sir|to whom it may concern|dear team|hi there)\b", body, re.I))
        if generic_open:
            add(12, "personalization", "generic_open", "medium", "personalization", "Opening is generic.", "Matched a mass-mail greeting.", "Use the recipient's name or a specific company detail.")
        elif not has_merge and not has_name_greeting and len(words) > 30:
            add(6, "personalization", "low_personalization", "low", "personalization", "Little personalization detected.", "No merge fields or named greeting found.", "Mention company, role, or a real detail — or use {{first_name}}.")

    matched_phrases = []
    for pattern, label in SPAMMY_PHRASES:
        m = re.search(pattern, combined, re.I)
        if m:
            matched_phrases.append((label, m.group(0)))
    if matched_phrases:
        label, evidence = matched_phrases[0]
        add(
            10 + min(8, 2 * (len(matched_phrases) - 1)),
            "content",
            "spam_phrase",
            "high" if len(matched_phrases) >= 2 else "medium",
            "content",
            f"Promotional wording: {label}.",
            f"Matched “{evidence}”" + (f" (+{len(matched_phrases) - 1} more)" if len(matched_phrases) > 1 else ""),
            "Rewrite in plain professional language without urgency or hype.",
        )

    urls = re.findall(r"https?://[^\s)>\]]+", combined, re.I)
    if len(urls) >= 4:
        add(14, "content", "many_links", "high", "content", "Link-heavy email.", f"{len(urls)} http(s) links.", "Keep one primary link on first touch.")
    elif len(urls) >= 2:
        add(5, "content", "few_links", "low", "content", "Multiple links.", f"{len(urls)} links.", "Prefer a single clear CTA.")

    for url in urls:
        host = (urlparse(url).hostname or "").lower()
        if any(host == h or host.endswith("." + h) for h in SHORTENER_HOSTS):
            add(16, "content", "short_link", "high", "content", "Uses a link shortener.", host or url[:60], "Use the full destination URL.")
            break
        if host and re.search(r"\d{1,3}(?:\.\d{1,3}){3}", host):
            add(10, "content", "ip_link", "medium", "content", "Link points at a raw IP address.", host, "Use a normal HTTPS domain.")

    if has_attachment:
        name = (attachment_name or "attachment").lower()
        if name.endswith((".exe", ".js", ".bat", ".cmd", ".scr", ".vbs")):
            add(30, "content", "risky_attachment", "high", "attachment", "Risky executable attachment type.", name, "Do not attach executables. Use a tracked PDF/document link instead.")
        elif name.endswith(".pdf"):
            add(2, "content", "pdf_attachment", "low", "attachment", "PDF attached to the email.", name, "Tracked viewer links often filter better than large inline PDFs for cold outreach.")

    # Scores (0–100), not an inbox probability
    def clamp(v: int) -> int:
        return max(0, min(100, v))

    spam_score = clamp(100 - content_penalty - subject_penalty // 2)
    writing_score = clamp(100 - writing_penalty)
    personalization_score = clamp(100 - personalization_penalty)
    subject_score = clamp(100 - subject_penalty)
    # technical filled by caller / auth check
    technical_score = 70  # neutral until auth checked

    if spam_score >= 80:
        spam_risk = "Low"
    elif spam_score >= 55:
        spam_risk = "Medium"
    else:
        spam_risk = "High"

    overall = clamp(int(round(
        spam_score * 0.35
        + writing_score * 0.2
        + personalization_score * 0.15
        + subject_score * 0.15
        + technical_score * 0.15
    )))

    if overall >= 80:
        band = "good"
        summary = "Content looks relatively safe. Inbox placement still depends on domain reputation and engagement."
    elif overall >= 60:
        band = "ok"
        summary = "Some risk factors — tighten wording before a bulk send."
    else:
        band = "risky"
        summary = "Several content risk patterns. Rewrite before launching."

    return {
        "score": overall,
        "band": band,
        "spam_risk": spam_risk,
        "summary": summary,
        "dimensions": {
            "writing_quality": writing_score,
            "personalization": personalization_score,
            "subject_relevance": subject_score,
            "spam_risk_indicators": spam_score,
            "technical_deliverability": technical_score,
        },
        "findings": _findings_payload(findings),
        "tips": [
            "Authenticate your sending domain (SPF, DKIM, DMARC) in Google Workspace.",
            "Warm the mailbox; avoid blasting a new list on day one.",
            "Personalize with a real detail — identical templates get filtered.",
            "One clear ask beats a long pitch.",
        ],
        "ai_available": ai_configured(),
        "disclaimer": "Scores estimate content risk only — not a measured probability of inbox delivery.",
    }


def rule_rewrite(*, subject: str, body: str, goal: str = "") -> dict:
    """Deterministic cleanup when OpenAI is not configured."""
    sub = (subject or "").strip()
    text = (body or "").strip()
    sub = re.sub(r"!{2,}", "!", sub)
    if sub.isupper() and len(sub) > 4:
        sub = sub.capitalize()
    sub = re.sub(r"^(re|fwd)\s*:\s*", "", sub, flags=re.I).strip() or sub
    if re.search(r"\bfree\b", sub, re.I):
        sub = re.sub(r"\bfree\b", "quick", sub, flags=re.I)
    if len(sub) > 70:
        sub = sub[:67].rstrip() + "…"
    text = re.sub(r"!{2,}", "!", text)
    replacements = [
        (r"\bclick here\b", "here's the link"),
        (r"\bact now\b", "when you have a moment"),
        (r"\bact immediately\b", "when convenient"),
        (r"\bbuy now\b", "take a look"),
        (r"\border now\b", "if useful"),
        (r"\blimited time\b", "this week"),
        (r"\bguarantee[d]?\b", "aim to"),
        (r"\burgent\b", "timely"),
        (r"\bthis is not spam\b", ""),
        (r"\bdear friend\b", "Hi"),
    ]
    for pattern, repl in replacements:
        text = re.sub(pattern, repl, text, flags=re.I)

    def soften_caps(match: re.Match[str]) -> str:
        word = match.group(0)
        return word if len(word) <= 3 else word.title()

    text = re.sub(r"\b[A-Z]{4,}\b", soften_caps, text)
    notes = [
        "Applied spam-phrase and punctuation cleanup (rule-based).",
        "Start Ollama (or set OPENAI_API_KEY) for fuller AI rewrites.",
    ]
    if goal.strip():
        notes.append(f"Goal noted: {goal.strip()[:120]}")
    analysis = analyze_deliverability(subject=sub, body=text)
    return {
        "subject": sub,
        "body_text": text,
        "notes": notes,
        "engine": "rules",
        "analysis": analysis,
    }


# Back-compat alias
_rule_rewrite = rule_rewrite


async def lookup_dns_txt(name: str) -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(
                "https://cloudflare-dns.com/dns-query",
                params={"name": name, "type": "TXT"},
                headers={"Accept": "application/dns-json"},
            )
        if response.status_code >= 400:
            return []
        answers = response.json().get("Answer") or []
        out = []
        for item in answers:
            data = str(item.get("data") or "").strip().strip('"')
            if data:
                out.append(data.replace('" "', ""))
        return out
    except Exception:
        return []


async def check_domain_auth(from_email: str | None) -> dict:
    """Best-effort SPF / DMARC TXT checks. DKIM needs a selector — reported as unknown."""
    email = (from_email or "").strip().lower()
    if "@" not in email:
        return {
            "domain": None,
            "spf": {"status": "unknown", "detail": "No From address to check."},
            "dkim": {"status": "unknown", "detail": "DKIM needs a selector from your DNS host; not inferred from the draft."},
            "dmarc": {"status": "unknown", "detail": "No From address to check."},
            "overall": "unknown",
        }
    domain = email.split("@", 1)[1]
    spf_records = await lookup_dns_txt(domain)
    dmarc_records = await lookup_dns_txt(f"_dmarc.{domain}")
    spf_hit = next((r for r in spf_records if "v=spf1" in r.lower()), None)
    dmarc_hit = next((r for r in dmarc_records if "v=dmarc1" in r.lower()), None)

    spf = (
        {"status": "pass", "detail": spf_hit[:180]}
        if spf_hit
        else {"status": "fail", "detail": f"No SPF TXT (v=spf1) found on {domain}."}
    )
    dmarc = (
        {"status": "pass", "detail": dmarc_hit[:180]}
        if dmarc_hit
        else {"status": "fail", "detail": f"No DMARC TXT found on _dmarc.{domain}."}
    )
    dkim = {
        "status": "unknown",
        "detail": "DKIM cannot be verified without your selector (e.g. google._domainkey). Check Google Admin → Gmail authentication.",
    }

    if spf["status"] == "pass" and dmarc["status"] == "pass":
        overall = "pass"
        tech_score = 92
    elif spf["status"] == "pass" or dmarc["status"] == "pass":
        overall = "warning"
        tech_score = 65
    else:
        overall = "fail"
        tech_score = 35

    return {
        "domain": domain,
        "spf": spf,
        "dkim": dkim,
        "dmarc": dmarc,
        "overall": overall,
        "technical_score": tech_score,
    }


async def full_analysis(
    *,
    subject: str,
    body: str,
    from_email: str | None = None,
    has_attachment: bool = False,
    attachment_name: str | None = None,
) -> dict:
    content = analyze_deliverability(
        subject=subject,
        body=body,
        has_attachment=has_attachment,
        attachment_name=attachment_name,
    )
    auth = await check_domain_auth(from_email)
    tech = int(auth.get("technical_score") or content["dimensions"]["technical_deliverability"])
    content["dimensions"]["technical_deliverability"] = tech
    content["authentication"] = {
        "domain": auth.get("domain"),
        "spf": auth["spf"],
        "dkim": auth["dkim"],
        "dmarc": auth["dmarc"],
        "overall": auth["overall"],
    }
    # Recompute overall with real technical score
    d = content["dimensions"]
    content["score"] = max(
        0,
        min(
            100,
            int(
                round(
                    d["spam_risk_indicators"] * 0.35
                    + d["writing_quality"] * 0.2
                    + d["personalization"] * 0.15
                    + d["subject_relevance"] * 0.15
                    + d["technical_deliverability"] * 0.15
                )
            ),
        ),
    )
    # Deliverability check label for UI
    if auth["overall"] == "pass" and content["spam_risk"] == "Low":
        content["deliverability_check"] = "Pass"
    elif auth["overall"] == "fail" or content["spam_risk"] == "High":
        content["deliverability_check"] = "Fail"
    else:
        content["deliverability_check"] = "Warning"
    return content
