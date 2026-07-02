"""Keyless web access: search via DuckDuckGo's lite HTML endpoint and fetch a
page's readable text. Atelier's identity is zero API keys, so this speaks to
https://lite.duckduckgo.com/lite/ (no key, no signup) instead of a paid search
API, and parses the plain HTML response with a tolerant regex rather than a
heavier HTML parser dependency.
"""

import html
import re

import httpx
from agency_swarm.tools import BaseTool
from pydantic import Field

_USER_AGENT = "Mozilla/5.0"
_TIMEOUT = 12

# The lite results page lists each hit as an anchor with class 'result-link'
# (attribute order on the <a> varies, so match the tag generically and pull
# href/class out of it) followed by a sibling <td class='result-snippet'>.
_ANCHOR_RE = re.compile(r"<a\s+([^>]*)>(.*?)</a>", re.IGNORECASE | re.DOTALL)
_HREF_RE = re.compile(r"""href=["']([^"']+)["']""", re.IGNORECASE)
_CLASS_RE = re.compile(r"""class=["']([^"']+)["']""", re.IGNORECASE)
_SNIPPET_RE = re.compile(
    r"""<td\s+class=["']result-snippet["'][^>]*>(.*?)</td>""",
    re.IGNORECASE | re.DOTALL,
)
_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL
)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _clean_text(fragment: str) -> str:
    """Strip tags out of an HTML fragment and normalize whitespace/entities."""
    no_tags = _TAG_RE.sub(" ", fragment)
    return _WHITESPACE_RE.sub(" ", html.unescape(no_tags)).strip()


def _parse_lite_results(page_html: str, max_results: int) -> list[dict]:
    """Pull (title, url, snippet) hits out of a lite.duckduckgo.com/lite/ page.

    Tolerant by design: it only looks for the anchor + snippet shapes DDG's
    lite page uses, skips internal duckduckgo.com links, and never raises on
    HTML it does not recognize (a mismatched result just gets skipped).
    """
    snippets = [_clean_text(m) for m in _SNIPPET_RE.findall(page_html)]

    results: list[dict] = []
    snippet_idx = 0
    for attrs, inner in _ANCHOR_RE.findall(page_html):
        class_match = _CLASS_RE.search(attrs)
        if not class_match or "result-link" not in class_match.group(1):
            continue
        # A result-link anchor was found; it "claims" the next snippet cell
        # regardless of whether it turns out usable, so title/snippet stay
        # paired by position even when a result is skipped below.
        snippet = snippets[snippet_idx] if snippet_idx < len(snippets) else ""
        snippet_idx += 1

        href_match = _HREF_RE.search(attrs)
        if not href_match:
            continue
        url = html.unescape(href_match.group(1))
        if not url.startswith(("http://", "https://")):
            continue
        if "duckduckgo.com" in url:
            continue

        title = _clean_text(inner)
        if not title:
            continue

        results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= max_results:
            break

    return results


class WebSearch(BaseTool):
    """
    Search the public web via DuckDuckGo (no API key required) and return the
    top results as title, url, and a short snippet.

    Use this for anything requiring current or external information the vault
    does not already have. Results come from a live search; if the search
    fails or returns nothing, this returns an explicit error string rather
    than fabricating results.
    """

    query: str = Field(
        ...,
        description="The search query.",
    )
    max_results: int = Field(
        default=6,
        description="Maximum number of results to return.",
    )

    def run(self) -> str:
        max_results = max(1, self.max_results)
        try:
            response = httpx.post(
                "https://lite.duckduckgo.com/lite/",
                data={"q": self.query},
                headers={"User-Agent": _USER_AGENT},
                timeout=_TIMEOUT,
                follow_redirects=True,
            )
        except Exception as exc:  # noqa: BLE001 - surface as an explicit error
            return f"WebSearch failed: {exc}"

        if response.status_code != 200:
            return f"WebSearch failed: HTTP {response.status_code} from DuckDuckGo"

        try:
            results = _parse_lite_results(response.text, max_results)
        except Exception as exc:  # noqa: BLE001 - never crash on odd HTML
            return f"WebSearch failed: could not parse results ({exc})"

        if not results:
            return f"WebSearch failed: no results for query {self.query!r}"

        lines = [f"WebSearch results for {self.query!r}:", ""]
        for i, result in enumerate(results, 1):
            lines.append(f"{i}. {result['title']} — {result['url']}")
            if result["snippet"]:
                lines.append(f"   {result['snippet']}")
        return "\n".join(lines)


class WebFetch(BaseTool):
    """
    Fetch a web page by URL and return its readable text (scripts, styles,
    and markup stripped, whitespace collapsed, capped to ~6000 characters).

    Only http:// and https:// URLs are allowed. Use this to read the actual
    content of a page found via WebSearch or supplied by the user. On failure
    this returns an explicit error string rather than fabricating content.
    """

    url: str = Field(
        ...,
        description="The http(s) URL to fetch.",
    )

    def run(self) -> str:
        scheme = self.url.split(":", 1)[0].lower() if ":" in self.url else ""
        if scheme not in ("http", "https"):
            return (
                f"WebFetch failed: unsupported URL scheme {scheme!r} "
                "(only http and https are allowed)"
            )

        try:
            response = httpx.get(
                self.url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_TIMEOUT,
                follow_redirects=True,
            )
        except Exception as exc:  # noqa: BLE001 - surface as an explicit error
            return f"WebFetch failed: {exc}"

        if response.status_code != 200:
            return f"WebFetch failed: HTTP {response.status_code} for {self.url}"

        no_scripts = _SCRIPT_STYLE_RE.sub(" ", response.text)
        text = _clean_text(no_scripts)
        if not text:
            return f"WebFetch failed: no readable text extracted from {self.url}"
        return text[:6000]
