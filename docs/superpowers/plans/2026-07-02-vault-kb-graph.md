# Vault Knowledge Base — Notion/Obsidian connectors + Graph view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (BATCHED mode — one implementer per Part, review at the END) to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Atelier use Notion + a user-chosen Obsidian vault as a read+write knowledge base, and add an Obsidian-style force-directed graph view of the vault.

**Architecture:** Backend is the FastAPI "lite" server (`lite_server.py`) + pure `shared_tools/` modules on the Claude Max subscription (zero API keys). New `shared_tools/notion_tools.py` wraps the Notion API over the already-bundled `httpx` as four `BaseTool` subclasses. `vault_core.py` gains settings-first vault resolution + a pure wikilink graph builder. `lite_server.py` gains config routes (`/config/notion-token`, `/config/vault`) and read routes (`/vault/graph`, `/vault/note`). The desktop app (vanilla JS, no build step) gains a "Knowledge base" Settings card and a canvas force-sim `graph.js` registered as a sidebar "Graph" view.

**Tech Stack:** Python 3 / FastAPI / httpx / pydantic / agency_swarm.tools.BaseTool / claude_agent_sdk; pytest via `.venv-ext/bin/python -m pytest`. Frontend: vanilla ES5-ish JS IIFE modules, `<canvas>` 2D, no dependency. Verify with `node --check` + playwright-core (`desktop/node_modules`).

## Global Constraints

- **Zero API keys ethos:** Notion auth is a user-pasted internal-integration token stored in the Atelier settings file; never fabricate results — missing token/API errors are explicit strings.
- **Notion is read + create + append ONLY.** No delete, no archive, no database-schema editing.
- **Commit style:** conventional commits, NO emojis (not even glyphs in messages), NO AI-attribution trailers.
- **Settings file:** one JSON at `ATELIER_SETTINGS_PATH` (default `~/.atelier/settings.json`), written `0600` via `save_settings()`. Secrets are redacted in `GET /config` (presence + last-4 hint only), never logged.
- **Vault safety unchanged:** `Sources/` immutable, containment guards on read/write stay intact.
- **Never 500 the graph:** `GET /vault/graph` degrades to `{"nodes": [], "edges": []}` on any error.
- **Notion API:** base `https://api.notion.com/v1`, header `Notion-Version: 2022-06-28`, `Authorization: Bearer <token>`, `timeout=15`.
- **Frontend module convention:** guard `window.Atelier`, a `console.assert` self-check, and a `── MANUAL TEST ──` comment block (mirror `views.js`/`govern.js`/`analytics.js`). Backend base URL `http://127.0.0.1:8765`; mutating fetches send `X-Atelier-Token` from `window.atelier.token` when present.

## File Structure

| File | Responsibility |
|---|---|
| `tests/conftest.py` | (modify) isolate `ATELIER_SETTINGS_PATH` per-test so the suite never reads the user's real settings |
| `shared_tools/vault_core.py` | (modify) `vault_root()` settings-first resolution + pure `build_graph()` / `_extract_wikilinks()` |
| `shared_tools/notion_tools.py` | (new) `NotionSearch/NotionRead/NotionCreatePage/NotionAppend` BaseTools + token/id helpers |
| `shared_tools/__init__.py` | (modify) export the four Notion tools |
| `lite_server.py` | (modify) LIGHT_TOOLS + Notion gating in `build_options`; `load_settings` preserves `notion_token`/`obsidian_vault`; config routes; `GET /vault/graph` + `GET /vault/note` |
| `desktop/app/views.js` | (modify) "Knowledge base" Settings card |
| `desktop/app/graph.js` | (new) canvas force-sim Graph view |
| `desktop/index.html` | (modify) `<script>` tag for graph.js |
| `tests/test_vault_graph.py` | (new) `vault_root()` resolution + `build_graph()` fixtures |
| `tests/test_notion_tools.py` | (new) mocked httpx for the four tools |
| `tests/test_notion_config.py` | (new) `/config/notion-token`(+validate/DELETE), `/config/vault`, `GET /config` shape, `build_options` gating, `/vault/graph`+`/vault/note` routes |

---

# PART B — Obsidian vault path in Settings

Touches `tests/conftest.py`, `shared_tools/vault_core.py`, `tests/test_vault_graph.py`.

### Task B1: Isolate the settings file across the whole test suite

**Files:**
- Modify: `tests/conftest.py`

**Interfaces:**
- Produces: every test now runs with `ATELIER_SETTINGS_PATH` pointing at a per-test tmp file (unless the test overrides it), so `vault_core` / `lite_server` never read the user's real `~/.atelier/settings.json`.

- [ ] **Step 1: Edit conftest to isolate the settings path**

In `tests/conftest.py`, add `"ATELIER_SETTINGS_PATH"` to `_ISOLATED_KEYS` and set it in the autouse fixture:

```python
_ISOLATED_KEYS = ("ATELIER_VERSIONS_DIR", "OBSIDIAN_VAULT", "ATELIER_SETTINGS_PATH")


@pytest.fixture(autouse=True)
def _isolate_versions_env(tmp_path):
    saved = {key: os.environ.get(key) for key in _ISOLATED_KEYS}
    os.environ["ATELIER_VERSIONS_DIR"] = str(tmp_path / "atelier-versions")
    os.environ["ATELIER_SETTINGS_PATH"] = str(tmp_path / "atelier-settings.json")
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
```

- [ ] **Step 2: Run the existing suite to confirm no regression**

Run: `.venv-ext/bin/python -m pytest -q tests/`
Expected: same pass count as before this task (the dual-auth `settings_file` fixture still wins via its own `monkeypatch.setenv`).

- [ ] **Step 3: Commit**

```bash
git add tests/conftest.py
git commit -m "test: isolate ATELIER_SETTINGS_PATH across the suite"
```

### Task B2: `vault_root()` resolves settings → env → default (validated dir)

**Files:**
- Modify: `shared_tools/vault_core.py` (add `import json`; `_settings_obsidian_vault()`; rewrite `vault_root()`)
- Test: `tests/test_vault_graph.py`

**Interfaces:**
- Produces: `vault_root() -> Path` resolving `settings["obsidian_vault"]` → env `OBSIDIAN_VAULT` → `DEFAULT_VAULT`, honoring a path only when it is an existing directory, else falling through. `_settings_obsidian_vault() -> str | None`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_vault_graph.py`:

```python
"""vault_core.vault_root() settings-first resolution + build_graph() (stdlib only)."""

import json
import os

from shared_tools import vault_core


def _write_settings(tmp_path, obj):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    return p


def test_vault_root_prefers_settings_over_env(tmp_path, monkeypatch):
    vault = tmp_path / "MyVault"
    vault.mkdir()
    envdir = tmp_path / "EnvVault"
    envdir.mkdir()
    monkeypatch.setenv("OBSIDIAN_VAULT", str(envdir))
    _write_settings(tmp_path, {"obsidian_vault": str(vault)})
    assert vault_core.vault_root() == vault


def test_vault_root_falls_back_to_env_when_no_setting(tmp_path, monkeypatch):
    envdir = tmp_path / "EnvVault"
    envdir.mkdir()
    monkeypatch.setenv("OBSIDIAN_VAULT", str(envdir))
    _write_settings(tmp_path, {"provider": "subscription"})  # no obsidian_vault
    assert vault_core.vault_root() == envdir


def test_vault_root_falls_back_when_setting_dir_missing(tmp_path, monkeypatch):
    envdir = tmp_path / "EnvVault"
    envdir.mkdir()
    monkeypatch.setenv("OBSIDIAN_VAULT", str(envdir))
    _write_settings(tmp_path, {"obsidian_vault": str(tmp_path / "nope")})
    assert vault_core.vault_root() == envdir


def test_vault_root_default_when_nothing_set(tmp_path, monkeypatch):
    monkeypatch.delenv("OBSIDIAN_VAULT", raising=False)
    _write_settings(tmp_path, {})
    assert vault_core.vault_root() == vault_core.Path(vault_core.DEFAULT_VAULT).expanduser()
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv-ext/bin/python -m pytest -q tests/test_vault_graph.py`
Expected: FAIL (settings-first resolution not implemented; `vault_root` ignores settings).

- [ ] **Step 3: Implement settings-first resolution**

In `shared_tools/vault_core.py` add `import json` to the imports, then replace `vault_root()`:

```python
def _settings_obsidian_vault():
    """The ``obsidian_vault`` path from the Atelier settings file, or None.

    Read directly (NOT via lite_server.load_settings) to avoid an import cycle
    and keep this module stdlib-only. Any failure — missing file, bad JSON,
    wrong type, empty — yields None so vault_root() falls through to env/default.
    """
    path = os.getenv("ATELIER_SETTINGS_PATH") or "~/.atelier/settings.json"
    try:
        data = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    value = data.get("obsidian_vault")
    return value if isinstance(value, str) and value else None


def vault_root() -> Path:
    """Vault root: settings ``obsidian_vault`` → env OBSIDIAN_VAULT → DEFAULT_VAULT.

    A settings- or env-supplied path is honored ONLY when it is an existing
    directory; otherwise resolution falls through to the next source (finally
    the default, returned even if absent so callers behave exactly as before).
    """
    for candidate in (_settings_obsidian_vault(), os.getenv("OBSIDIAN_VAULT")):
        if candidate and Path(candidate).expanduser().is_dir():
            return Path(candidate).expanduser()
    return Path(DEFAULT_VAULT).expanduser()
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv-ext/bin/python -m pytest -q tests/test_vault_graph.py`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the full suite (no regression)**

Run: `.venv-ext/bin/python -m pytest -q tests/`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add shared_tools/vault_core.py tests/test_vault_graph.py
git commit -m "feat(vault): resolve vault root from settings, then env, then default"
```

### Task B3: pure `build_graph()` + `_extract_wikilinks()` in vault_core

**Files:**
- Modify: `shared_tools/vault_core.py`
- Test: `tests/test_vault_graph.py`

**Interfaces:**
- Produces: `build_graph(root: Path) -> dict` returning `{"nodes": [{"id","title","path","degree","ghost"}], "edges": [{"source","target"}]}`. `_extract_wikilinks(text: str) -> list[str]`. Node `id` is the note's vault-relative path WITHOUT the `.md` suffix; ghost nodes (unresolved link targets) have `path=None, ghost=True`. Consumed by `GET /vault/graph` (Part D).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_vault_graph.py`:

```python
def _mk(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_extract_wikilinks_strips_alias_and_section():
    text = "See [[Iris]] and [[Projects/Hermes|Hermes]] plus [[Notes#Heading]]."
    assert vault_core._extract_wikilinks(text) == ["Iris", "Projects/Hermes", "Notes"]


def test_build_graph_nodes_edges_and_degree(tmp_path):
    _mk(tmp_path, "Projects/Iris.md", "Iris links to [[Hermes]].")
    _mk(tmp_path, "Projects/Hermes.md", "Hermes standalone.")
    g = vault_core.build_graph(tmp_path)
    ids = {n["id"] for n in g["nodes"]}
    assert ids == {"Projects/Iris", "Projects/Hermes"}
    assert {"source": "Projects/Iris", "target": "Projects/Hermes"} in g["edges"]
    deg = {n["id"]: n["degree"] for n in g["nodes"]}
    assert deg["Projects/Iris"] == 1 and deg["Projects/Hermes"] == 1


def test_build_graph_creates_ghost_for_unresolved_link(tmp_path):
    _mk(tmp_path, "A.md", "A points to [[Nowhere]].")
    g = vault_core.build_graph(tmp_path)
    ghosts = [n for n in g["nodes"] if n["ghost"]]
    assert len(ghosts) == 1 and ghosts[0]["id"] == "Nowhere" and ghosts[0]["path"] is None


def test_build_graph_skips_sources_and_self_links(tmp_path):
    _mk(tmp_path, "Sources/Immutable.md", "[[A]]")   # Sources/ is skipped
    _mk(tmp_path, "A.md", "[[A]] self link ignored.")  # self-link dropped
    g = vault_core.build_graph(tmp_path)
    assert {n["id"] for n in g["nodes"]} == {"A"}
    assert g["edges"] == []


def test_build_graph_empty_vault(tmp_path):
    assert vault_core.build_graph(tmp_path) == {"nodes": [], "edges": []}
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv-ext/bin/python -m pytest -q tests/test_vault_graph.py -k "graph or wikilink"`
Expected: FAIL (`_extract_wikilinks` / `build_graph` not defined).

- [ ] **Step 3: Implement the parser + builder**

Append to `shared_tools/vault_core.py`:

```python
_WIKILINK_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")


def _extract_wikilinks(text: str):
    """Return the wikilink targets in ``text`` with ``|alias`` and ``#section`` stripped."""
    targets = []
    for match in _WIKILINK_RE.finditer(text or ""):
        raw = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        if raw:
            targets.append(raw)
    return targets


def _resolve_link(target: str, by_path: dict, by_stem: dict):
    """Resolve a wikilink target to a real node id (rel path w/o .md) or None."""
    t = target.strip().lstrip("/")
    if t.endswith(".md"):
        t = t[:-3]
    if t in by_path:
        return t
    hits = by_stem.get(Path(t).name.lower())
    return hits[0] if hits else None


def build_graph(root: Path) -> dict:
    """Parse the vault's notes into an Obsidian-style link graph (pure, no IO deps).

    Returns ``{"nodes": [...], "edges": [...]}``. A node id is the note's
    vault-relative path without the ``.md`` suffix. Unresolved link targets
    become ghost nodes (``path=None, ghost=True``). Sources/ + skipped dirs are
    excluded (via _iter_notes); self-links and duplicate directed edges are
    dropped. Never raises on unreadable files (they are skipped).
    """
    notes = []  # (rel_no_ext, title, text)
    for path, rel in _iter_notes(Path(root)):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel_no_ext = rel[:-3] if rel.endswith(".md") else rel
        notes.append((rel_no_ext, _title_for(path, text), text))

    by_path = {rel: rel for rel, _, _ in notes}
    by_stem = {}
    for rel, _, _ in notes:
        by_stem.setdefault(Path(rel).name.lower(), []).append(rel)

    nodes = {}
    for rel, title, _ in notes:
        nodes[rel] = {"id": rel, "title": title, "path": rel + ".md",
                      "degree": 0, "ghost": False}

    edges = []
    seen = set()
    for rel, _, text in notes:
        for target in _extract_wikilinks(text):
            dest = _resolve_link(target, by_path, by_stem)
            if dest is None:
                dest = target
                if dest not in nodes:
                    nodes[dest] = {"id": dest, "title": target, "path": None,
                                   "degree": 0, "ghost": True}
            if dest == rel:
                continue
            key = (rel, dest)
            if key in seen:
                continue
            seen.add(key)
            edges.append({"source": rel, "target": dest})
            nodes[rel]["degree"] += 1
            nodes[dest]["degree"] += 1

    return {"nodes": list(nodes.values()), "edges": edges}
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv-ext/bin/python -m pytest -q tests/test_vault_graph.py`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add shared_tools/vault_core.py tests/test_vault_graph.py
git commit -m "feat(vault): parse wikilinks into a graph of nodes and edges"
```

---

# PART A — Notion connector tools

Touches `shared_tools/notion_tools.py` (new), `shared_tools/__init__.py`, `lite_server.py`, `tests/test_notion_tools.py` (new).

### Task A1: The four Notion BaseTools (mocked-httpx TDD)

**Files:**
- Create: `shared_tools/notion_tools.py`
- Test: `tests/test_notion_tools.py`

**Interfaces:**
- Produces: `NotionSearch(query, max_results=8)`, `NotionRead(page)`, `NotionCreatePage(parent_id, title, content)`, `NotionAppend(page_id, content)` — all `BaseTool` subclasses with a `run() -> str`. Helpers `_notion_token() -> str`, `_extract_id(s) -> str`, `_paragraph_blocks(content) -> list`. Module constant `NOT_CONNECTED` (the not-connected message). Consumed by `lite_server` (Task A2).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_notion_tools.py`:

```python
"""Notion tools over a mocked httpx (no network). Token comes from a tmp
ATELIER_SETTINGS_PATH; every failure mode returns an explicit string."""

import json
import os

import pytest

from shared_tools import notion_tools


@pytest.fixture
def token(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"notion_token": "secret_abc"}), encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    return "secret_abc"


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def test_missing_token_returns_not_connected(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text("{}", encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    assert notion_tools.NotionSearch(query="x").run() == notion_tools.NOT_CONNECTED


def test_search_formats_results(token, monkeypatch):
    payload = {"results": [
        {"object": "page", "id": "id1", "url": "https://notion.so/id1",
         "properties": {"Name": {"type": "title",
                                 "title": [{"plain_text": "My Page"}]}}},
    ]}
    monkeypatch.setattr(notion_tools.httpx, "post",
                        lambda *a, **k: _Resp(200, payload))
    out = notion_tools.NotionSearch(query="my").run()
    assert "My Page" in out and "id1" in out and "https://notion.so/id1" in out


def test_search_api_error_is_explicit(token, monkeypatch):
    monkeypatch.setattr(notion_tools.httpx, "post",
                        lambda *a, **k: _Resp(401, {"message": "unauthorized"}))
    out = notion_tools.NotionSearch(query="my").run()
    assert "401" in out and "failed" in out.lower()


def test_read_resolves_url_to_id(token, monkeypatch):
    seen = {}

    def fake_get(url, *a, **k):
        seen["url"] = url
        if url.endswith("/blocks/" + "a" * 32 + "/children"):
            return _Resp(200, {"results": []})
        return _Resp(200, {"properties": {"title": {"type": "title",
                     "title": [{"plain_text": "Doc"}]}}})

    monkeypatch.setattr(notion_tools.httpx, "get", fake_get)
    out = notion_tools.NotionRead(page="https://www.notion.so/My-Doc-" + "a" * 32).run()
    assert "Doc" in out
    assert "a" * 32 in seen["url"]


def test_create_page_returns_url(token, monkeypatch):
    captured = {}

    def fake_post(url, *a, **k):
        captured["json"] = k.get("json")
        return _Resp(200, {"url": "https://notion.so/new"})

    monkeypatch.setattr(notion_tools.httpx, "post", fake_post)
    out = notion_tools.NotionCreatePage(parent_id="parent", title="T",
                                        content="hello").run()
    assert "https://notion.so/new" in out
    assert captured["json"]["parent"] == {"page_id": "parent"}


def test_append_ok(token, monkeypatch):
    monkeypatch.setattr(notion_tools.httpx, "patch",
                        lambda *a, **k: _Resp(200, {"results": []}))
    out = notion_tools.NotionAppend(page_id="pg", content="more text").run()
    assert "ok" in out.lower()


def test_paragraph_blocks_chunks_long_text():
    blocks = notion_tools._paragraph_blocks("x" * 4500)
    # Notion caps rich_text content at 2000 chars per block.
    assert all(len(b["paragraph"]["rich_text"][0]["text"]["content"]) <= 2000
               for b in blocks)
    assert len(blocks) >= 3
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_tools.py`
Expected: FAIL (module `shared_tools.notion_tools` does not exist).

- [ ] **Step 3: Implement `shared_tools/notion_tools.py`**

```python
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
    match = _ID_RE.search(compact)
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_tools.py`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add shared_tools/notion_tools.py tests/test_notion_tools.py
git commit -m "feat(notion): add search/read/create/append Notion tools"
```

### Task A2: Wire Notion into the atelier server, gated on a stored token

**Files:**
- Modify: `shared_tools/__init__.py` (export the four tools)
- Modify: `lite_server.py` (import + LIGHT_TOOLS + `NOTION_TOOL_NAMES` + `load_settings` preservation + `build_options` gating)
- Test: `tests/test_notion_config.py` (new — the `build_options` gating tests; config-route tests are added in Part C to the same file)

**Interfaces:**
- Consumes: the four tools from Task A1.
- Produces: `lite_server.NOTION_TOOL_NAMES` (list of `mcp__atelier__Notion*`); `build_options()` includes the Notion tool names + a Notion system-prompt line IFF `load_settings().get("notion_token")` is set; `load_settings()` now preserves `notion_token` and `obsidian_vault` across merge-writes.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_notion_config.py`:

```python
"""Notion + vault config wiring: build_options gating + (Part C) config routes."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lite_server  # noqa: E402


def _settings(tmp_path, obj):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    return p


def test_load_settings_preserves_notion_and_vault(tmp_path):
    _settings(tmp_path, {"provider": "subscription",
                         "notion_token": "secret_x", "obsidian_vault": "/tmp"})
    s = lite_server.load_settings()
    assert s["notion_token"] == "secret_x"
    assert s["obsidian_vault"] == "/tmp"


def test_build_options_attaches_notion_when_token_set(tmp_path):
    _settings(tmp_path, {"provider": "subscription", "notion_token": "secret_x"})
    opts = lite_server.build_options()
    assert "mcp__atelier__NotionSearch" in opts.allowed_tools
    assert "Notion" in opts.system_prompt


def test_build_options_omits_notion_without_token(tmp_path):
    _settings(tmp_path, {"provider": "subscription"})
    opts = lite_server.build_options()
    assert "mcp__atelier__NotionSearch" not in opts.allowed_tools
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_config.py`
Expected: FAIL (Notion not wired; `load_settings` drops the keys).

- [ ] **Step 3: Export the tools**

In `shared_tools/__init__.py`, add the four Notion tools to the exports (mirror how `WebSearch`/`WebFetch` are exported — add the import line and, if there is an `__all__`, list them).

- [ ] **Step 4: Import + register in lite_server**

In `lite_server.py`, add to the `from shared_tools import (...)` block (near `WebSearch, WebFetch`):

```python
    NotionSearch,
    NotionRead,
    NotionCreatePage,
    NotionAppend,
```

Add the four classes to `LIGHT_TOOLS` (after `WebFetch`). Immediately after the `ATELIER_SERVER, ATELIER_ALLOWED_TOOLS = build_atelier_server(LIGHT_TOOLS)` line, add:

```python
# Notion tools are served by the atelier MCP server always, but only allowed
# (and advertised in the system prompt) when a token is configured — same
# conditional pattern as the govern roster. This keeps the toolset clean when
# Notion isn't set up.
NOTION_TOOL_NAMES = [
    "mcp__atelier__NotionSearch",
    "mcp__atelier__NotionRead",
    "mcp__atelier__NotionCreatePage",
    "mcp__atelier__NotionAppend",
]
_NOTION_PROMPT = (
    "\n\nNotion is connected: use NotionSearch/NotionRead/NotionCreatePage/"
    "NotionAppend to search, read, create, and append to the user's Notion "
    "workspace as a knowledge base. You can create and append but never delete."
)
```

- [ ] **Step 5: Preserve the keys in `load_settings`**

In `load_settings()` (after the `model` block), add:

```python
    notion = data.get("notion_token")
    if isinstance(notion, str) and notion:
        settings["notion_token"] = notion
    vault = data.get("obsidian_vault")
    if isinstance(vault, str) and vault:
        settings["obsidian_vault"] = vault
```

- [ ] **Step 6: Gate the tools + prompt in `build_options`**

In `build_options()`, replace the three initializers:

```python
    mcp_servers = {"atelier": ATELIER_SERVER}
    allowed_tools = list(ATELIER_ALLOWED_TOOLS)
    system_prompt = ATELIER_INSTRUCTIONS
```

with:

```python
    mcp_servers = {"atelier": ATELIER_SERVER}
    # Notion tools are gated on a stored token (removed here, re-added below).
    allowed_tools = [t for t in ATELIER_ALLOWED_TOOLS if t not in NOTION_TOOL_NAMES]
    system_prompt = ATELIER_INSTRUCTIONS
    if settings.get("notion_token"):
        allowed_tools += NOTION_TOOL_NAMES
        system_prompt += _NOTION_PROMPT
```

Then in the govern branch below, change the roster reassignment from
`system_prompt = (ATELIER_INSTRUCTIONS + "\n\nYou govern these sub-agent cards: " ...)`
to append to the current prompt instead (so the Notion line survives):

```python
            system_prompt = (
                system_prompt
                + "\n\nYou govern these sub-agent cards: "
                + roster
                + ". Use DelegateToSubagent(subagent, task) to hand a subtask"
                " to one of them by id or name; the sub-agent runs it and its"
                " reply is returned to you."
            )
```

- [ ] **Step 7: Run to verify they pass**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_config.py`
Expected: PASS.

- [ ] **Step 8: Run the full suite; fix any tool-count assertions**

Run: `.venv-ext/bin/python -m pytest -q tests/`
Expected: all green. If `tests/test_tools_route.py` or `tests/test_swarm_wiring.py` assert an exact tool count or list, update them to include the four Notion tools (they are legitimately new tools).

- [ ] **Step 9: Commit**

```bash
git add shared_tools/__init__.py lite_server.py tests/test_notion_config.py
git commit -m "feat(notion): wire Notion tools into the agent, gated on a stored token"
```

---

# PART C — Settings "Knowledge base" card

Touches `lite_server.py` (config routes) and `desktop/app/views.js` (the card).

### Task C1: Config routes for the Notion token + vault path

**Files:**
- Modify: `lite_server.py` (`GET /config` fields; new routes; request models; hint helper)
- Test: `tests/test_notion_config.py` (append)

**Interfaces:**
- Consumes: `load_settings`/`save_settings`, `_reset_chat_client`.
- Produces: `GET /config` gains `notion_connected` (bool), `notion_token_hint` (last-4), `obsidian_vault` (str). New routes `POST/DELETE /config/notion-token`, `POST /config/notion-token/validate`, `POST /config/vault`. Consumed by the frontend (Task C2).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_notion_config.py`:

```python
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    return TestClient(lite_server.app)


def test_config_reports_notion_and_vault(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    body = c.get("/config").json()
    assert body["notion_connected"] is False
    assert body["obsidian_vault"] == ""
    r = c.post("/config/notion-token", json={"token": "secret_abcd1234"})
    assert r.json()["notion_connected"] is True
    body = c.get("/config").json()
    assert body["notion_connected"] is True
    assert body["notion_token_hint"].endswith("1234")
    assert "secret_abcd1234" not in json.dumps(body)  # never the full token


def test_set_and_delete_notion_token(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    c.post("/config/notion-token", json={"token": "secret_z"})
    assert lite_server.load_settings()["notion_token"] == "secret_z"
    c.delete("/config/notion-token")
    assert "notion_token" not in lite_server.load_settings()


def test_set_vault_validates_dir(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    good = tmp_path / "vault"
    good.mkdir()
    assert c.post("/config/vault", json={"path": str(good)}).json()["ok"] is True
    assert lite_server.load_settings()["obsidian_vault"] == str(good)
    bad = c.post("/config/vault", json={"path": str(tmp_path / "missing")})
    assert bad.status_code == 400


def test_validate_notion_token_mocked(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)

    class _Resp:
        status_code = 200

        def json(self):
            return {"bot": {"workspace_name": "My WS"}}

    class _FakeAsync:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsync)
    r = c.post("/config/notion-token/validate", json={"token": "secret_q"})
    assert r.json()["valid"] is True and r.json()["workspace"] == "My WS"
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_config.py -k "config or vault or validate_notion"`
Expected: FAIL (routes/fields missing).

- [ ] **Step 3: Add the hint helper + request models**

In `lite_server.py`, near `_API_KEY_RE` / the config request models, add:

```python
def _notion_token_hint(token: str) -> str:
    """Last-4 hint for a Notion token; never the full value."""
    token = token or ""
    return ("…" + token[-4:]) if len(token) >= 4 else ("…" if token else "")


class NotionTokenRequest(BaseModel):
    token: str


class NotionTokenValidateRequest(BaseModel):
    token: str | None = None


class VaultPathRequest(BaseModel):
    path: str
```

- [ ] **Step 4: Extend `GET /config`**

In the `config()` return dict, add:

```python
        "notion_connected": bool(settings.get("notion_token")),
        "notion_token_hint": _notion_token_hint(settings.get("notion_token") or ""),
        "obsidian_vault": settings.get("obsidian_vault") or "",
```

- [ ] **Step 5: Add the routes**

After the existing `/config/api-key/validate` route, add:

```python
@app.post("/config/notion-token")
async def set_notion_token(req: NotionTokenRequest):
    """Store the Notion integration token (0600, merge-preserving). Token-gated."""
    token = req.token.strip()
    if not token:
        return JSONResponse({"error": "empty token"}, status_code=400)
    settings = load_settings()
    settings["notion_token"] = token
    save_settings(settings)
    await _reset_chat_client()  # next turn rebuilds with the Notion tools + prompt
    return {"ok": True, "notion_connected": True,
            "notion_token_hint": _notion_token_hint(token)}


@app.delete("/config/notion-token")
async def delete_notion_token():
    """Clear the Notion token; the tools + prompt drop on the next chat rebuild."""
    settings = load_settings()
    settings.pop("notion_token", None)
    save_settings(settings)
    await _reset_chat_client()
    return {"ok": True, "notion_connected": False}


@app.post("/config/notion-token/validate")
async def validate_notion_token(req: NotionTokenValidateRequest | None = None):
    """Live-check a token (supplied, else stored) against GET /v1/users/me.

    Never 500 and never echoes the token: the token appears only in the
    outbound Authorization header.
    """
    supplied = (req.token if req else None) or ""
    token = supplied.strip() or (load_settings().get("notion_token") or "")
    if not token:
        return {"valid": False, "detail": "no token to validate"}
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10.0) as hc:
            resp = await hc.get(
                "https://api.notion.com/v1/users/me",
                headers={"Authorization": f"Bearer {token}",
                         "Notion-Version": "2022-06-28"},
            )
    except Exception:  # noqa: BLE001
        return {"valid": False, "detail": "could not reach api.notion.com"}
    if resp.status_code == 200:
        workspace = ""
        try:
            workspace = (resp.json().get("bot") or {}).get("workspace_name") or ""
        except Exception:  # noqa: BLE001
            workspace = ""
        return {"valid": True, "detail": "token accepted", "workspace": workspace}
    if resp.status_code in (401, 403):
        return {"valid": False, "detail": "token rejected by Notion"}
    return {"valid": False, "detail": f"unexpected response {resp.status_code}"}


@app.post("/config/vault")
async def set_vault_path(req: VaultPathRequest):
    """Validate + store the Obsidian vault path (must be an existing directory)."""
    path = os.path.expanduser((req.path or "").strip())
    if not path or not os.path.isdir(path):
        return JSONResponse({"error": "not a directory"}, status_code=400)
    settings = load_settings()
    settings["obsidian_vault"] = path
    save_settings(settings)
    return {"ok": True, "obsidian_vault": path}
```

- [ ] **Step 6: Run to verify they pass**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_config.py`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add lite_server.py tests/test_notion_config.py
git commit -m "feat(config): Notion token + vault path routes and config fields"
```

### Task C2: "Knowledge base" Settings card (frontend)

**Files:**
- Modify: `desktop/app/views.js` (inside `mountSettings`, plus `loadConfig` feeding it)

**Interfaces:**
- Consumes: `GET /config` (`notion_connected`, `notion_token_hint`, `obsidian_vault`) and the `POST/DELETE /config/notion-token`, `POST /config/notion-token/validate`, `POST /config/vault` routes via the existing `api()` helper.
- Produces: a "Knowledge base" card in the Settings view mirroring the "Model provider" card, fed by the existing `loadConfig()`.

- [ ] **Step 1: Read the current Settings mount + loadConfig**

Read `desktop/app/views.js` from `function mountSettings(container)` (~496) through the end of the settings IIFE, focusing on the provider card (built ~549–760), where cards are appended to `wrap`, and the `loadConfig()` function that fans a `GET /config` response out to `applyProviderCfg` etc.

- [ ] **Step 2: Build the Knowledge base card**

Following the provider-card idiom (`btn`, `noteLine`, `setNote`, `provAction`-style single-in-flight guard), add a `kbCard` built from the same primitives. Include:
- A **Notion token** row: a `password` input (placeholder `secret_… / ntn_…`, `autocomplete=off`), a `Save` button (`POST /config/notion-token`), a `Validate` button (`POST /config/notion-token/validate`, shows `detail` + `workspace` in the note line), and a hint row (`Connected · …1234` + a `Remove` button → `DELETE /config/notion-token`) shown only when `notion_connected`.
- An **Obsidian vault** row: a text input (placeholder `/path/to/vault`), a `Save` button (`POST /config/vault`); on a 400 show `not a directory` in an error note.
- A single-in-flight guard per cluster (reuse the `provAction` pattern renamed `kbAction`), disabled until the first `/config` lands, degrade to "unavailable" when `/config` is unreachable.

Append `kbCard` to `wrap` right after `provCard` (before the appearance/read-only cards). Add an `applyKbCfg(cfg)` and `degradeKbCard()` and call them from `loadConfig` alongside `applyProviderCfg`/`degradeProviderCard`. The token VALUE never enters the DOM — only the server's `notion_token_hint`.

- [ ] **Step 3: Extend the `── MANUAL TEST ──` block**

In the settings IIFE's manual-test comment, add steps: open Settings → a "Knowledge base" card shows; paste a token → Save → the hint row appears as `Connected · …abcd`; Validate → note shows the workspace (or "token rejected"); Remove → hint row disappears; set the vault path to a real dir → "saved", to a bad path → "not a directory".

- [ ] **Step 4: Syntax-check**

Run: `node --check desktop/app/views.js`
Expected: no output (valid). (Live Playwright verification happens in the Verify phase.)

- [ ] **Step 5: Commit**

```bash
git add desktop/app/views.js
git commit -m "feat(desktop): Knowledge base settings card (Notion token + vault path)"
```

---

# PART D — Obsidian-style graph view

Touches `lite_server.py` (`GET /vault/graph`, `GET /vault/note`), `desktop/app/graph.js` (new), `desktop/index.html` (script tag).

### Task D1: `GET /vault/graph` + `GET /vault/note` routes

**Files:**
- Modify: `lite_server.py`
- Test: `tests/test_notion_config.py` (append) — routes over a temp vault

**Interfaces:**
- Consumes: `vault_core.build_graph`, `vault_core.vault_root`, `vault_core.read_note`.
- Produces: `GET /vault/graph → {"nodes":[...],"edges":[...]}` (never 500); `GET /vault/note?path=<rel> → {"path","markdown"}` (404 when missing). Consumed by `graph.js` (Task D2).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_notion_config.py`:

```python
def test_vault_graph_route(tmp_path, monkeypatch):
    (tmp_path / "A.md").write_text("[[B]]", encoding="utf-8")
    (tmp_path / "B.md").write_text("hi", encoding="utf-8")
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    c = TestClient(lite_server.app)
    g = c.get("/vault/graph").json()
    assert {n["id"] for n in g["nodes"]} == {"A", "B"}
    assert {"source": "A", "target": "B"} in g["edges"]


def test_vault_note_route(tmp_path, monkeypatch):
    (tmp_path / "A.md").write_text("# Hello\nbody", encoding="utf-8")
    monkeypatch.setenv("OBSIDIAN_VAULT", str(tmp_path))
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "s.json"))
    c = TestClient(lite_server.app)
    assert "Hello" in c.get("/vault/note", params={"path": "A"}).json()["markdown"]
    assert c.get("/vault/note", params={"path": "nope"}).status_code == 404
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_config.py -k "vault_graph or vault_note"`
Expected: FAIL (routes missing).

- [ ] **Step 3: Add the routes**

In `lite_server.py` (near the other vault/versions routes), add:

```python
@app.get("/vault/graph")
async def vault_graph():
    """The vault as an Obsidian-style link graph. Never 500 — degrades to empty."""
    try:
        return vault_core.build_graph(vault_core.vault_root())
    except Exception:  # noqa: BLE001 - a bad vault yields an empty graph, not a 500
        return {"nodes": [], "edges": []}


@app.get("/vault/note")
async def vault_note(path: str):
    """Read one vault note's markdown by relative path/title (containment-guarded)."""
    try:
        text = vault_core.read_note(path)
    except FileNotFoundError:
        return JSONResponse({"error": "note not found"}, status_code=404)
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "could not read note"}, status_code=400)
    return {"path": path, "markdown": text[:20000]}
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv-ext/bin/python -m pytest -q tests/test_notion_config.py`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lite_server.py tests/test_notion_config.py
git commit -m "feat(vault): graph and note read endpoints"
```

### Task D2: `graph.js` canvas force-sim Graph view

**Files:**
- Create: `desktop/app/graph.js`
- Modify: `desktop/index.html` (add `<script defer src="app/graph.js"></script>` after `analytics.js`, line ~177)

**Interfaces:**
- Consumes: `window.Atelier.views.register`, `window.Atelier.spawnApp` (optional, for click-to-open), the `GET /vault/graph` + `GET /vault/note` routes.
- Produces: a registered `section:'analytics'` view id `graph` labeled "Graph" that renders the vault as a force-directed canvas graph.

- [ ] **Step 1: Write `desktop/app/graph.js`**

Full module (register a Graph view; custom velocity-Verlet force sim; degree-sized nodes; zoom/pan/drag; hover-highlight; click-to-open). Mirror the analytics.js registration + views.js self-check/manual-test conventions:

```javascript
'use strict';

/* ===========================================================================
   Atelier feature module — Graph view   (app/graph.js)

   An Obsidian-style global graph of the vault. Registers a sidebar "Graph"
   view (Atelier.views, section 'analytics'), fetches GET /vault/graph, and
   renders it on a <canvas> with a dependency-free force simulation (link
   springs + charge repulsion + centering gravity, velocity Verlet, cooling
   alpha). Node radius scales with degree; hover highlights a node + its direct
   neighbours and dims the rest; wheel zooms, background drag pans, a node drag
   pins while held; clicking a node opens that note (GET /vault/note → a note
   card via Atelier.spawnApp when available). Ghost nodes (unresolved links)
   render hollow. Respects the theme via canvas reads of CSS vars.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Reload the app. Console shows "[graph] view registered." with no
      console.assert failures. A "Graph" row appears in the sidebar Analytics
      group.
   2. Click "Graph" → a full-canvas view opens; within ~1s the vault renders as
      a moving force graph that settles. Bigger (higher-degree) notes are
      larger. Ghost nodes are hollow.
   3. Hover a node → it + its neighbours stay bright, everything else dims;
      the node's title label shows.
   4. Wheel over the canvas → zoom in/out about the cursor. Drag the background
      → pan. Drag a node → it follows the cursor and pins while held, releasing
      it lets the sim resume.
   5. Click a node → its note opens as a card (or, with spawnApp absent, a
      toast/console line naming the note). Ghost nodes (no file) do nothing.
   6. Header ↻ re-fetches /vault/graph. × closes back to the board.
   7. Toggle theme (Settings/customization) → graph colours follow.
   =========================================================================== */
(function () {
  const A = window.Atelier;
  if (!A || !A.views || typeof A.views.register !== 'function') {
    console.warn('[graph] Atelier.views not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';
  const VIEW_ID = 'graph';

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function mount(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'graph-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let nodes = [];
    let edges = [];
    let raf = 0;
    let alpha = 1;
    let disposed = false;

    // view transform (screen = world*scale + offset)
    let scale = 1;
    let offX = 0;
    let offY = 0;

    // interaction state
    let hoverNode = null;
    let dragNode = null;
    let panning = false;
    let last = { x: 0, y: 0 };
    const neighbours = new Map(); // id -> Set(neighbour ids)

    function size() {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: rect.width, h: rect.height };
    }
    let view = size();

    function toWorld(sx, sy) {
      return { x: (sx - offX) / scale, y: (sy - offY) / scale };
    }

    function seed() {
      // deterministic-ish scatter (no Math.random dependency on layout quality)
      const cx = view.w / 2;
      const cy = view.h / 2;
      nodes.forEach((n, i) => {
        const ang = (i / Math.max(1, nodes.length)) * Math.PI * 2;
        const r = 40 + (i % 7) * 30;
        n.x = cx + Math.cos(ang) * r;
        n.y = cy + Math.sin(ang) * r;
        n.vx = 0;
        n.vy = 0;
        n.r = 4 + Math.sqrt(n.degree || 0) * 3;
      });
    }

    function indexNeighbours() {
      neighbours.clear();
      nodes.forEach((n) => neighbours.set(n.id, new Set()));
      edges.forEach((e) => {
        if (neighbours.has(e.source)) neighbours.get(e.source).add(e.target);
        if (neighbours.has(e.target)) neighbours.get(e.target).add(e.source);
      });
    }

    function step() {
      const cx = view.w / 2;
      const cy = view.h / 2;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      // charge repulsion (O(n^2) — the vault is small)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = (2600 * alpha) / d2;
          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          a.vx += ux * f;
          a.vy += uy * f;
          b.vx -= ux * f;
          b.vy -= uy * f;
        }
      }
      // link springs
      edges.forEach((e) => {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 90) * 0.02 * alpha;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f;
        a.vy += uy * f;
        b.vx -= ux * f;
        b.vy -= uy * f;
      });
      // centering gravity + integrate
      nodes.forEach((n) => {
        if (n === dragNode) return;
        n.vx += (cx - n.x) * 0.002 * alpha;
        n.vy += (cy - n.y) * 0.002 * alpha;
        n.vx *= 0.85;
        n.vy *= 0.85;
        n.x += n.vx;
        n.y += n.vy;
      });
      alpha *= 0.992;
      if (alpha < 0.02) alpha = 0.02; // gentle idle jitter floor
    }

    function draw() {
      const edgeCol = cssVar('--line', 'rgba(120,120,120,0.35)');
      const nodeCol = cssVar('--accent', '#c98a5e');
      const inkCol = cssVar('--ink', '#333');
      ctx.clearRect(0, 0, view.w, view.h);
      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      const active = hoverNode
        ? neighbours.get(hoverNode.id) || new Set()
        : null;

      // edges
      const byId = new Map(nodes.map((n) => [n.id, n]));
      edges.forEach((e) => {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) return;
        const lit = !hoverNode
          || a === hoverNode || b === hoverNode;
        ctx.globalAlpha = lit ? 0.55 : 0.08;
        ctx.strokeStyle = edgeCol;
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      });

      // nodes
      nodes.forEach((n) => {
        const lit = !hoverNode || n === hoverNode
          || (active && active.has(n.id));
        ctx.globalAlpha = lit ? 1 : 0.2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        if (n.ghost) {
          ctx.strokeStyle = nodeCol;
          ctx.lineWidth = 1.5 / scale;
          ctx.stroke();
        } else {
          ctx.fillStyle = nodeCol;
          ctx.fill();
        }
        // labels: always for hovered/neighbour, else when zoomed in
        if (lit && (hoverNode || scale > 1.4)) {
          ctx.globalAlpha = lit ? 0.9 : 0.2;
          ctx.fillStyle = inkCol;
          ctx.font = (11 / scale) + 'px system-ui, sans-serif';
          ctx.fillText(n.title || n.id, n.x + n.r + 2 / scale, n.y + 3 / scale);
        }
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    function frame() {
      if (disposed) return;
      step();
      draw();
      raf = requestAnimationFrame(frame);
    }

    function pickNode(sx, sy) {
      const w = toWorld(sx, sy);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = n.x - w.x;
        const dy = n.y - w.y;
        if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return n;
      }
      return null;
    }

    function openNote(n) {
      if (!n || n.ghost || !n.path) return;
      fetch(BASE + '/vault/note?path=' + encodeURIComponent(n.id))
        .then((r) => r.json())
        .then((d) => {
          const md = (d && d.markdown) || '';
          if (typeof A.spawnApp === 'function') {
            const el = A.spawnApp('note');
            const ta = el && el.querySelector('.app-body textarea');
            if (ta) {
              ta.value = md;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.blur();
              return;
            }
          }
          if (A.toast) A.toast('Opened note: ' + (n.title || n.id));
          else console.log('[graph] note', n.id, md.slice(0, 200));
        })
        .catch(() => { if (A.toast) A.toast('Could not open note.'); });
    }

    // ── events ────────────────────────────────────────────────────────────
    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = toWorld(sx, sy);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      scale = Math.max(0.2, Math.min(5, scale * factor));
      offX = sx - before.x * scale;
      offY = sy - before.y * scale;
    }
    function onDown(e) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const n = pickNode(sx, sy);
      last = { x: sx, y: sy };
      if (n) { dragNode = n; n.moved = false; }
      else panning = true;
    }
    function onMove(e) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (dragNode) {
        const w = toWorld(sx, sy);
        dragNode.x = w.x;
        dragNode.y = w.y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        dragNode.moved = true;
        alpha = Math.max(alpha, 0.3);
      } else if (panning) {
        offX += sx - last.x;
        offY += sy - last.y;
        last = { x: sx, y: sy };
      } else {
        hoverNode = pickNode(sx, sy);
        canvas.style.cursor = hoverNode ? 'pointer' : 'default';
      }
    }
    function onUp(e) {
      if (dragNode && !dragNode.moved) openNote(dragNode);
      dragNode = null;
      panning = false;
    }
    function onResize() { view = size(); }

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onResize);

    function load() {
      fetch(BASE + '/vault/graph')
        .then((r) => r.json())
        .then((d) => {
          if (disposed) return;
          nodes = (d.nodes || []).map((n) => Object.assign({}, n));
          edges = (d.edges || []).slice();
          view = size();
          seed();
          indexNeighbours();
          alpha = 1;
          if (!raf) frame();
        })
        .catch(() => {
          ctx.fillStyle = cssVar('--ink-dim', '#999');
          ctx.font = '13px system-ui, sans-serif';
          ctx.fillText('Graph unavailable — backend unreachable.', 20, 30);
        });
    }
    load();
    mount._reload = load;

    return function cleanup() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
    };
  }

  A.views.register(VIEW_ID, {
    label: 'Graph',
    icon: '◈',
    section: 'analytics',
    mount: mount,
    onRefresh: function () { if (mount._reload) mount._reload(); },
  });

  console.assert(typeof A.views.register === 'function', '[graph] views API missing');
  console.log('[graph] view registered.');
})();
```

- [ ] **Step 2: Register the script tag**

In `desktop/index.html`, after the `analytics.js` line (~177), add:

```html
    <script defer src="app/graph.js"></script>
```

- [ ] **Step 3: Syntax-check**

Run: `node --check desktop/app/graph.js`
Expected: no output (valid).

- [ ] **Step 4: Commit**

```bash
git add desktop/app/graph.js desktop/index.html
git commit -m "feat(desktop): Obsidian-style force-directed vault graph view"
```

---

## Verify (whole feature)

- [ ] Backend: `.venv-ext/bin/python -m pytest -q tests/` → all green.
- [ ] Frontend syntax: `node --check desktop/app/views.js && node --check desktop/app/graph.js`.
- [ ] Live: drive the packaged app with playwright-core (`desktop/node_modules`), `executablePath=/Applications/Atelier.app/Contents/MacOS/Atelier`, wait ~10s for "on subscription", screenshot (1) Settings → the Knowledge base card, (2) the Graph view rendered.

## Rebuild + reinstall

- [ ] Quit the running app: `osascript -e 'tell application "Atelier" to quit'`.
- [ ] `cd desktop && npm run dist` (electron-builder; reuses build-staging/python-env with httpx).
- [ ] `ditto dist/mac-arm64/Atelier.app /Applications/Atelier.app`, relaunch.
- [ ] Fast-forward-merge `swarm-extensions` → `main` LOCALLY (no push): `git checkout main && git merge --ff-only swarm-extensions && git checkout swarm-extensions`.

---

## Self-Review notes (author)

- **Spec coverage:** A (notion_tools + wiring: A1, A2), B (vault_root + graph parser: B2, B3; B1 is test hygiene), C (routes C1 + card C2), D (endpoints D1 + graph.js D2). All acceptance criteria mapped.
- **Cross-cutting risk pinned:** `load_settings()` must preserve `notion_token` + `obsidian_vault` (A2 step 5) or the merge-write routes silently wipe each other and the model/provider writes wipe them — this is the single highest-risk interaction.
- **Type consistency:** node shape `{id,title,path,degree,ghost}` and edge shape `{source,target}` are identical across `build_graph` (B3), the graph route (D1), and `graph.js` (D2). Notion tool class names match `NOTION_TOOL_NAMES` (A2).
- **Placeholders:** none — backend steps carry full test + impl code; frontend graph.js is complete; the KB card (C2) is described against the concrete provider-card primitives it mirrors (bespoke interactive DOM, like the provider card, is not reproduced line-for-line but its structure, routes, and states are fully specified).
