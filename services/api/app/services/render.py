import re
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlparse

import nh3

from app.core.config import get_settings

ALLOWED_TAGS = {"p", "br", "strong", "em", "a", "ul", "ol", "li", "blockquote"}
URL_RE = re.compile(r"https://[^\s<]+")
# Bold is line-local only — DOTALL collapsed multi-line **signature** into one bold run.
BOLD_OR_URL = re.compile(r"\*\*([^*\n]+?)\*\*|(https://[^\s<]+)")


def is_safe_http_url(url: str, allow_app_origins: bool = True) -> bool:
    if not url or any(char in url for char in ("\r", "\n", "\t", " ")):
        return False
    if len(url) > 2000:
        return False
    settings = get_settings()
    if allow_app_origins and (
        url.startswith(settings.public_app_url.rstrip("/") + "/")
        or url.startswith(settings.public_api_url.rstrip("/") + "/")
        or url == settings.public_app_url.rstrip("/")
        or url == settings.public_api_url.rstrip("/")
    ):
        parsed = urlparse(url)
        return parsed.scheme in {"http", "https"} and bool(parsed.hostname) and not parsed.username
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username:
        return False
    host = parsed.hostname.lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        return False
    return True


def _strip_bold_from_signature(text: str) -> str:
    """Keep the email signature unbolded and multi-line (Compose bold must not flatten it)."""
    markers = ("yashjeet.space", "github.com/yj004", "linkedin.com/in/yashjeet-singh")
    lower = text.lower()
    hit = -1
    for marker in markers:
        at = lower.find(marker)
        if at >= 0:
            hit = at if hit < 0 else min(hit, at)
    if hit < 0:
        return text
    # Start of signature: "Best regards" / blank line before portfolio, else marker line.
    head = text[:hit]
    match = re.search(r"(?is)(?:\n|^)((?:Best regards|Regards|Best),?\s*\n)", head)
    if match:
        start = match.start(1)
    else:
        start = head.rfind("\n\n")
        start = 0 if start < 0 else start + 2
    body, sig = text[:start], text[start:]
    # Remove markdown bold wrappers from the signature block only.
    sig = re.sub(r"\*\*", "", sig)
    return body + sig


def plain_to_html(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return "<p></p>"
    normalized = _strip_bold_from_signature(normalized)
    # Expand any remaining multi-line **blocks** into per-line bold so newlines become <br>.
    def _expand_multiline_bold(match: re.Match[str]) -> str:
        inner = match.group(1)
        if "\n" not in inner:
            return match.group(0)
        return "\n".join(
            f"**{line}**" if line.strip() else line for line in inner.split("\n")
        )

    normalized = re.sub(r"\*\*([\s\S]+?)\*\*", _expand_multiline_bold, normalized)
    blocks = re.split(r"\n{2,}", normalized)
    return "".join(f"<p>{_inline(block)}</p>" for block in blocks)


def _inline(block: str) -> str:
    out: list[str] = []
    position = 0
    for match in BOLD_OR_URL.finditer(block):
        out.append(escape(block[position : match.start()]).replace("\n", "<br>"))
        bold = match.group(1)
        if bold is not None:
            # Preserve intentional line breaks if any slip through.
            out.append(f"<strong>{escape(bold).replace(chr(10), '<br>')}</strong>")
        else:
            raw = match.group(2)
            url = raw
            trail = ""
            while url and url[-1] in ".,);":
                trail = url[-1] + trail
                url = url[:-1]
            if is_safe_http_url(url):
                safe = escape(url, quote=True)
                out.append(f'<a href="{safe}">{escape(url)}</a>{escape(trail)}')
            else:
                out.append(escape(raw))
        position = match.end()
    out.append(escape(block[position:]).replace("\n", "<br>"))
    return "".join(out)


def sanitize_html(value: str) -> str:
    cleaned = nh3.clean(
        value,
        tags=ALLOWED_TAGS,
        attributes={"a": {"href"}},
        url_schemes={"https", "mailto"},
        link_rel="noopener noreferrer",
        strip_comments=True,
    )
    return _drop_unsafe_anchors(cleaned)


def _drop_unsafe_anchors(value: str) -> str:
    class Filter(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.parts: list[str] = []
            self.skip = 0

        def handle_starttag(self, tag, attrs):
            if tag == "a":
                href = dict(attrs).get("href") or ""
                if href.startswith("mailto:"):
                    address = href[7:]
                    if not re.fullmatch(r"[^<>\s]+@[^<>\s]+", address):
                        self.skip += 1
                        return
                elif not is_safe_http_url(href):
                    self.skip += 1
                    return
            if self.skip:
                return
            rendered = _render_start(tag, attrs)
            self.parts.append(rendered)

        def handle_endtag(self, tag):
            if self.skip:
                if tag == "a":
                    self.skip -= 1
                return
            if tag not in {"br"}:
                self.parts.append(f"</{tag}>")

        def handle_startendtag(self, tag, attrs):
            if self.skip:
                return
            self.parts.append(_render_start(tag, attrs, close=True))

        def handle_data(self, data):
            if self.skip:
                return
            self.parts.append(escape(data))

    parser = Filter()
    parser.feed(value)
    return "".join(parser.parts)


def _render_start(tag: str, attrs: list[tuple[str, str | None]], close: bool = False) -> str:
    pieces = [f"<{tag}"]
    for key, val in attrs:
        if val is None:
            continue
        pieces.append(f' {key}="{escape(val, quote=True)}"')
    pieces.append(" />" if close else ">")
    return "".join(pieces)


class LinkRewriter(HTMLParser):
    def __init__(self, replace) -> None:
        super().__init__(convert_charrefs=True)
        self.replace = replace
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        updated = []
        for key, val in attrs:
            if tag == "a" and key == "href" and val:
                val = self.replace(val)
            updated.append((key, val))
        self.parts.append(_render_start(tag, updated))

    def handle_endtag(self, tag):
        self.parts.append(f"</{tag}>")

    def handle_startendtag(self, tag, attrs):
        self.parts.append(_render_start(tag, attrs, close=True))

    def handle_data(self, data):
        self.parts.append(escape(data))

    def result(self) -> str:
        return "".join(self.parts)


def rewrite_html_links(html: str, replace) -> str:
    parser = LinkRewriter(replace)
    parser.feed(html)
    return parser.result()


def html_to_text(html: str) -> str:
    class TextExtractor(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.parts: list[str] = []

        def handle_starttag(self, tag, attrs):
            if tag == "br":
                self.parts.append("\n")
            elif tag == "p" and self.parts:
                self.parts.append("\n\n")
            if tag == "a":
                href = dict(attrs).get("href")
                self._href = href
            else:
                self._href = None

        def handle_data(self, data):
            self.parts.append(data)
            href = getattr(self, "_href", None)
            if href and href not in data:
                self.parts.append(f" ({href})")
                self._href = None

    extractor = TextExtractor()
    extractor.feed(html)
    return re.sub(r"\n{3,}", "\n\n", "".join(extractor.parts)).strip()
