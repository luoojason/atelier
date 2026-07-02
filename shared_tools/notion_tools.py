"""Notion connector: search / read / create / append over the Notion API via
httpx (already bundled — zero extra deps). The integration token is read from
the Atelier settings file (``notion_token``). Read + create + append ONLY —
never delete or archive. A missing token or any API error returns an explicit
string; results are never fabricated (honors the anti-confabulation rule)."""

import json
import os
import re
from pathlib import Path

import httpx
from agency_swarm.tools import BaseTool
from pydantic import Field

_BASE = "https://api.notion.com/v1"
_VERSION = "2022-06-28"
_TIMEOUT = 15
NOT_CONNECTED = "Notion isn't connected — add a token in Settings."

_ID_RE = re.compile(r"[0-9a-fA-F]{32}")
# Notion URLs place the id as the trailing segment of the slug (e.g.
# ".../My-Doc-<32 hex>"). Trying an end-anchored match first avoids a
# leftmost, unanchored search swallowing a hex-looking title character (e.g.
# the "c" in "Doc") into the id; a plain raw id still matches via the
# unanchored fallback in _extract_id.
_ID_RE_END = re.compile(r"[0-9a-fA-F]{32}$")


def _settings_path() -> Path:
    return Path(os.getenv("ATELIER_SETTINGS_PATH")
                or "~/.atelier/settings.json").expanduser()


def _notion_token() -> str:
    """The stored Notion token, or '' when unset/unreadable (never raises)."""
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    token = data.get("notion_token") if isinstance(data, dict) else None
    return token if isinstance(token, str) else ""


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": _VERSION,
        "Content-Type": "application/json",
    }


def _extract_id(page: str) -> str:
    """Pull a 32-hex Notion id out of a raw id or a Notion URL (dashes ignored)."""
    compact = (page or "").replace("-", "")
    match = _ID_RE_END.search(compact) or _ID_RE.search(compact)
    return match.group(0) if match else (page or "").strip()


def _title_of(obj: dict) -> str:
    """Best-effort title from a page/database object's properties (else '(untitled)')."""
    props = obj.get("properties") or {}
    for prop in props.values():
        if isinstance(prop, dict) and prop.get("type") == "title":
            parts = [t.get("plain_text", "") for t in (prop.get("title") or [])]
            text = "".join(parts).strip()
            if text:
                return text
    # top-level title (databases)
    parts = [t.get("plain_text", "") for t in (obj.get("title") or [])]
    return "".join(parts).strip() or "(untitled)"


def _paragraph_blocks(content: str):
    """Split content into Notion paragraph blocks, chunked to Notion's 2000-char cap."""
    blocks = []
    for para in (content or "").split("\n"):
        chunk = para
        while True:
            piece, chunk = chunk[:2000], chunk[2000:]
            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text",
                                             "text": {"content": piece}}]},
            })
            if not chunk:
                break
    return blocks or [{
        "object": "block", "type": "paragraph",
        "paragraph": {"rich_text": []},
    }]


def _block_text(block: dict) -> str:
    """Readable text of a single block (paragraph/heading/list/todo/quote/code)."""
    btype = block.get("type", "")
    body = block.get(btype)
    if not isinstance(body, dict):
        return ""
    rich = body.get("rich_text") or body.get("caption") or []
    return "".join(t.get("plain_text", "") for t in rich).strip()


class NotionSearch(BaseTool):
    """
    Search the connected Notion workspace for pages and databases matching a
    query. Returns each hit as ``title — id — url``. Requires a Notion token
    set in Settings; without one, returns an explicit not-connected message
    rather than fabricating results.
    """

    query: str = Field(..., description="Text to search for across Notion.")
    max_results: int = Field(default=8, description="Maximum hits to return.")

    def run(self) -> str:
        token = _notion_token()
        if not token:
            return NOT_CONNECTED
        try:
            resp = httpx.post(
                f"{_BASE}/search",
                headers=_headers(token),
                json={"query": self.query,
                      "page_size": max(1, min(self.max_results, 50))},
                timeout=_TIMEOUT,
            )
        except Exception as exc:  # noqa: BLE001 - surface as explicit error
            return f"NotionSearch failed: {exc}"
        if resp.status_code != 200:
            return f"NotionSearch failed: HTTP {resp.status_code} from Notion"
        results = (resp.json() or {}).get("results") or []
        if not results:
            return f"NotionSearch: no results for {self.query!r}"
        lines = [f"NotionSearch results for {self.query!r}:", ""]
        for i, obj in enumerate(results[: self.max_results], 1):
            lines.append(f"{i}. {_title_of(obj)} — {obj.get('id', '')} — "
                         f"{obj.get('url', '')}")
        return "\n".join(lines)


class NotionRead(BaseTool):
    """
    Read a Notion page's title and text by page id or Notion URL. Returns
    readable text (capped ~6000 chars). Requires a Notion token; without one,
    returns an explicit not-connected message. On an API error returns an
    explicit error string, never fabricated content.
    """

    page: str = Field(..., description="A Notion page id or a Notion page URL.")

    def run(self) -> str:
        token = _notion_token()
        if not token:
            return NOT_CONNECTED
        page_id = _extract_id(self.page)
        headers = _headers(token)
        try:
            meta = httpx.get(f"{_BASE}/pages/{page_id}", headers=headers,
                             timeout=_TIMEOUT)
            if meta.status_code != 200:
                return f"NotionRead failed: HTTP {meta.status_code} from Notion"
            children = httpx.get(f"{_BASE}/blocks/{page_id}/children",
                                 headers=headers, timeout=_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            return f"NotionRead failed: {exc}"
        title = _title_of(meta.json() or {})
        body_lines = []
        if children.status_code == 200:
            for block in (children.json() or {}).get("results", []):
                text = _block_text(block)
                if text:
                    body_lines.append(text)
        out = f"# {title}\n\n" + "\n".join(body_lines)
        return out[:6000]


class NotionCreatePage(BaseTool):
    """
    Create a new Notion page under a parent page. ``parent_id`` is the parent
    page's id (or URL). Returns the new page's URL. Requires a Notion token;
    without one, returns an explicit not-connected message. Never deletes.
    """

    parent_id: str = Field(..., description="Parent page id or URL.")
    title: str = Field(..., description="Title of the new page.")
    content: str = Field(default="", description="Body text (paragraphs).")

    def run(self) -> str:
        token = _notion_token()
        if not token:
            return NOT_CONNECTED
        body = {
            "parent": {"page_id": _extract_id(self.parent_id)},
            "properties": {"title": {"title": [{"text": {"content": self.title}}]}},
            "children": _paragraph_blocks(self.content),
        }
        try:
            resp = httpx.post(f"{_BASE}/pages", headers=_headers(token),
                              json=body, timeout=_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            return f"NotionCreatePage failed: {exc}"
        if resp.status_code != 200:
            return f"NotionCreatePage failed: HTTP {resp.status_code} from Notion"
        return f"Created Notion page: {(resp.json() or {}).get('url', '(no url)')}"


class NotionAppend(BaseTool):
    """
    Append paragraph blocks to an existing Notion page. ``page_id`` is the page
    id (or URL). Requires a Notion token; without one, returns an explicit
    not-connected message. Append only — never deletes or overwrites blocks.
    """

    page_id: str = Field(..., description="Target page id or URL.")
    content: str = Field(..., description="Text to append (paragraphs).")

    def run(self) -> str:
        token = _notion_token()
        if not token:
            return NOT_CONNECTED
        try:
            resp = httpx.patch(
                f"{_BASE}/blocks/{_extract_id(self.page_id)}/children",
                headers=_headers(token),
                json={"children": _paragraph_blocks(self.content)},
                timeout=_TIMEOUT,
            )
        except Exception as exc:  # noqa: BLE001
            return f"NotionAppend failed: {exc}"
        if resp.status_code != 200:
            return f"NotionAppend failed: HTTP {resp.status_code} from Notion"
        return "ok — appended to the Notion page."
