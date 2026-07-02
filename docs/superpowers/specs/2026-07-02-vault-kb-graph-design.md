# Design: Vault knowledge base — Notion/Obsidian connectors + Obsidian-style graph view

- **Date:** 2026-07-02
- **Status:** Approved (design); ready for implementation plan
- **Branch:** `swarm-extensions` (now == `main`, HEAD `614afa3`)
- **Scope owner:** Atelier lite backend (`lite_server.py`, `shared_tools/`) + desktop app (`desktop/`)

## Context

Atelier already treats an Obsidian `.md` vault as the agent's knowledge base:
- `shared_tools/vault_core.py` — `vault_root()` (`:27`) reads env `OBSIDIAN_VAULT`, default `/Users/jasonluo08/Desktop/AI Brain`; VaultSearch/VaultRead/VaultWrite operate on it (Sources/ immutable, containment-guarded).
- Durable facts live in `memory_core.py` (`~/.openswarm/swarm_memory.json`).
- Settings/credentials use one JSON file via `load_settings()`/`save_settings()` (`lite_server.py:137`), the dual-auth pattern (provider + `anthropic_api_key`, `0600`, redacted in `GET /config`).
- The heavy swarm has Composio (`ManageConnections.py` → Gmail/Slack/**Notion**/…) but it needs a Composio key and is **not** in the lite (desktop) backend.
- The lite agent's tools are `LIGHT_TOOLS` (`lite_server.py:100`) + `WebSearch`/`WebFetch`; assembled by `build_atelier_server(LIGHT_TOOLS)` into `ATELIER_ALLOWED_TOOLS`. `build_options` (`:195`) attaches tools + conditional system-prompt lines (e.g. the govern roster).
- The desktop has a sidebar "views" system (`desktop/app/views.js`, e.g. the Analytics view) and a Settings view (`GET /config`).

## Goal

Let Atelier use **Notion** (and a user-chosen **Obsidian** vault) as a read+write knowledge base/memory, and add an **Obsidian-style graph view** of the vault. Decisions locked with the user:
- Add a **direct Notion connector** (not Composio); expose the Obsidian vault path in Settings.
- **Read + write** (search, read, create pages, append) — **no delete/archive**.
- Notion auth = a **Notion internal-integration token** pasted into Settings.
- Graph view = a new sidebar **"Graph"** tab, force-directed, rendered with a **custom canvas force-sim** (no new dependency).

---

## Part A — Notion connector

**New file `shared_tools/notion_tools.py`** — four `BaseTool` subclasses (mirror `web_tools.py`/`VaultSearch` pattern), calling the Notion API over `httpx` (already bundled). Header `Authorization: Bearer <token>`, `Notion-Version: 2022-06-28`, `timeout=15`. Token read via `load_settings().get("notion_token")`.
- `NotionSearch(query, max_results=8)` → `POST /v1/search` → list of `title — id — url`.
- `NotionRead(page)` → resolve id from a page id or Notion url → `GET /v1/pages/{id}` (properties/title) + `GET /v1/blocks/{id}/children` (block text); return readable text, cap ~6000 chars.
- `NotionCreatePage(parent_id, title, content)` → `POST /v1/pages` with `parent={page_id}`, title + paragraph blocks; return the new page url.
- `NotionAppend(page_id, content)` → `PATCH /v1/blocks/{id}/children` appending paragraph blocks; return ok.
- **No delete/archive.** On missing token → return explicit `"Notion isn't connected — add a token in Settings"` (honors the anti-confabulation rule). On HTTP/API error → explicit error string, never a fabricated result.

**Wiring (`lite_server.py`):** add the four tools to the atelier server. In `build_options` (`:195`), attach the Notion tools to `allowed_tools` **and** append a Notion system-prompt line **only when a token is configured** (same conditional pattern as the govern roster at `:276`). This keeps the toolset clean when Notion isn't set up.

**Acceptance:** with a token set, an agent turn can search/read/create/append in Notion (mocked in tests, live-smoke with a real token); with no token, the tools return the not-connected message and no Notion prompt line is attached.

## Part B — Obsidian vault path in Settings

**`shared_tools/vault_core.py:27`** — `vault_root()` resolves in order: `load_settings().get("obsidian_vault")` → env `OBSIDIAN_VAULT` → `DEFAULT_VAULT`. (Import `load_settings` lazily to avoid a cycle, or read the settings file directly.) Validation: a chosen path must be an existing directory; else the write route returns 400 and `vault_root()` falls back.

**Acceptance:** setting `obsidian_vault` in settings points VaultSearch/Read/Write and the graph endpoint at that vault; unset falls back to env/default.

## Part C — Settings "Knowledge base" card

**Backend (`lite_server.py`, mirror the dual-auth routes):**
- `POST /config/notion-token {token}` — store `settings["notion_token"]` (`0600`, merge-preserving), token-gated; `DELETE /config/notion-token` — clear; `POST /config/notion-token/validate` — live check against `GET /v1/users/me`, returns `{ok, workspace?}`.
- `POST /config/vault {path}` — validate dir exists, store `settings["obsidian_vault"]`.
- `GET /config` gains: `notion_connected` (bool), `notion_token_hint` (last-4 only), `obsidian_vault` (path).

**Frontend (Settings view):** a new "Knowledge base" card mirroring the "Model provider" card — a Notion token field (password input, Save / Validate / Remove; Validate shows the connected workspace) + an Obsidian vault path field (Save, validated). Self-check + `── MANUAL TEST ──` block.

**Acceptance:** the card saves/validates/removes the Notion token and sets the vault path; `GET /config` reflects state; the token is never returned in full.

## Part D — Obsidian-style graph view

**Backend (`lite_server.py`):** `GET /vault/graph` — scan the vault's `.md` files (reuse `vault_core`, respect Sources/ + containment), extract `[[wikilinks]]` (strip `|alias` and `#section`, resolve by note name/path). Return `{nodes:[{id, title, path, degree}], edges:[{source, target}]}`. Unresolved link targets become **ghost nodes** (flagged), as Obsidian shows them. Never 500 (degrade to `{nodes:[],edges:[]}` on a bad vault). Cache-light (recompute per request; the vault is small).

**Frontend — new `desktop/app/graph.js`** + a **"Graph"** entry in the sidebar views system (`views.js`), registered in `index.html`:
- A `<canvas>` filling the view. Fetch `/vault/graph`, run a **custom force simulation** (link springs + charge repulsion + centering gravity, velocity Verlet, cooling alpha) — ~150 lines, no dependency.
- Obsidian-like: node radius scales with `degree`; thin edges; node labels (fade in on zoom); **zoom/pan** (wheel + background drag); **drag a node** (pin while dragging); **hover a node → highlight it + direct neighbors, dim the rest**; **click a node → open that note** (VaultRead → a note/markdown card via the existing app API). Respect the current theme (light/dark via CSS vars).
- Module convention: guard `window.Atelier`, `console.assert` self-check, `── MANUAL TEST ──` block (mirror `link.js`/`govern.js`).

**Acceptance:** the Graph tab renders the vault as a force-directed graph matching Obsidian's core feel (force layout, degree-sized nodes, hover-highlight, zoom/pan/drag, click-to-open); `/vault/graph` returns correct nodes/edges for a known vault.

---

## Data flow

- **Notion:** agent turn → tool call `mcp__atelier__Notion*` → `httpx` → Notion API (Bearer token from settings) → result text back to the agent.
- **Graph:** Graph tab opens → `GET /vault/graph` → `graph.js` force-sim renders → click node → open note card.

## Error handling / safety

- Notion: read+write but **no delete/archive**; missing token and API errors are explicit (never fabricated). Token stored `0600`, redacted in `/config`, stripped from logs.
- Vault path: validated as an existing dir; Sources/ immutability + containment guards unchanged.
- Graph endpoint never 500s; ghost nodes are labeled, not silently dropped.

## Testing

Backend `pytest` (via `.venv-ext/bin/python -m pytest`):
- `tests/test_notion_tools.py` (new): mocked `httpx` for search/read/create/append; the not-connected error; url→id resolution; explicit error on API failure.
- `tests/test_lite_sessions.py` / config tests: `POST/DELETE /config/notion-token` (+validate, mocked), `POST /config/vault` (dir validation), `GET /config` shape (`notion_connected`/hint/`obsidian_vault`); `build_options` attaches Notion tools + prompt line iff a token is set.
- `tests/` graph: `GET /vault/graph` against a temp vault (fixtures) → correct nodes/edges + ghost nodes; `vault_root()` settings-first resolution.
Frontend: no automated harness — `graph.js` + the KB Settings card ship a `console.assert` self-check + `── MANUAL TEST ──`; verify with `node --check` + a live Playwright screenshot (graph rendered; KB card saves a token).

## Files

| File | Change |
|---|---|
| `shared_tools/notion_tools.py` | **new** — NotionSearch/Read/CreatePage/Append |
| `shared_tools/vault_core.py` | `vault_root()` settings-first resolution |
| `lite_server.py` | LIGHT_TOOLS + Notion gating in build_options; `/config/notion-token`(+validate/DELETE), `/config/vault`, `GET /config` fields; `GET /vault/graph` + wikilink parser |
| desktop Settings view module | "Knowledge base" card |
| `desktop/app/graph.js` | **new** — canvas force-sim graph view |
| `desktop/app/views.js` + `desktop/index.html` | register the "Graph" sidebar view + script tag |
| `tests/test_notion_tools.py` (+ session/config/graph tests) | coverage |

## Build order

1. **B** vault-path-in-settings → 2. **A** Notion tools → 3. **C** KB Settings card (backend + frontend) → 4. **D** graph endpoint + graph.js. Each independently testable. After build: verify (pytest + Playwright), then **rebuild + reinstall** `/Applications/Atelier.app` (`cd desktop && npm run dist` → `ditto dist/mac-arm64/Atelier.app /Applications/`).

## Out of scope / follow-ups

- Composio multi-service connectors (Gmail/Slack/etc.) — declined in favor of the direct Notion connector.
- Notion delete/archive, database-schema editing, OAuth flow — deferred (token + read/create/append is enough for a memory system).
- Graph view filters/search, saved layouts, local-graph-per-note — possible later polish; v1 targets the global graph with Obsidian's core interactions.
