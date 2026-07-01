# Atelier — resume prompt

Paste the block below to pick up after a context clear.

---

Resume the **Atelier** project. Atelier is my fork of VRSEN/OpenSwarm at `~/Desktop/openswarm` (branch `swarm-extensions`), extended into a deliverable workforce **and a desktop app**, all running on my **Claude Max subscription** (zero API keys).

**Read these first for full state** (do not rebuild from scratch): the wiki page `Projects/OpenSwarm.md` in the Obsidian vault `~/Desktop/AI Brain`; and in the fork: `docs/EXTENSIONS.md`, `docs/UI-BACKLOG.md` (54 ranked OpenSwarm features), `BACKLOG.md`.

**Current state**
- **Agency** (Python, Agency Swarm): backlog #1–#12 + a Claude-subscription model backend (`claude_subscription_model.py`, set `DEFAULT_MODEL=claude-cli`) + a Campaign meta-agent (gated: brief → produce → Critic → publish). ~200 tests. Hardened by a 28-bug adversarial debug. Full multi-specialist agency needs heavy media deps (weasyprint/playwright/moviepy) that live in the installed OpenSwarm app.
- **Desktop app**: `~/Desktop/openswarm/desktop/` — an Electron app (`Atelier.app` installed at `/Applications`, own icon). UI copies OpenSwarm's real app (I read `/Applications/OpenSwarm.app`): warm cream **infinite canvas** (dotted grid, terracotta accent), sidebar, centered search, bottom dock, minimap, zoom. Backed by `lite_server.py` — a FastAPI running ONE Atelier agent (vault/memory/brief/campaign tools) on the subscription. Modular UI: `desktop/app/{core,widgets,apps,palette,customization}.js` against a `window.Atelier` API (in `core.js`).
- **Built + verified**: customizable widgets (double-click canvas → picker → Metric/Status/Chart/Checklist/Clock, gear-configurable, persisted), dock app cards (note/browser/workflow/calendar/history), ⌘K command palette, themes (Clay/Slate/Forest) + layout/viewport persistence.
- **To run the app**: it depends on the fork venv `~/Desktop/openswarm/.venv-ext` + the `claude` CLI logged into Max. `open /Applications/Atelier.app` (backend cold-start ~15-25s). To iterate on the UI: edit `desktop/app/*.js` / `desktop/index.html` / `desktop/styles.css`, then `cd desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir` and `cp -R dist/mac-arm64/Atelier.app /Applications/`.

**UI areas to work on** (all 54 in `docs/UI-BACKLOG.md`; highest-value):
1. **Multiple dashboards** — named boards (create/rename/duplicate/delete/switch), each its own cards + pan/zoom + thumbnail; sidebar list with search. (high)
2. **Embedded browser cards** — real Electron `<webview>` tiles with a URL bar + persistent partition (OpenSwarm's `BROWSER_PARTITION`). (high, L)
3. **Markdown note editor** — a real editor (CodeMirror-style) in the note card. (M)
4. **Fit-to-view** + app-wide **keyboard shortcuts** (⌘M add-app, Esc, etc.). (S)
5. **Live metrics** — wire the widgets to real data via a new `/metrics` endpoint on `lite_server.py` (session tokens, run ledger counts, deliverables).
6. **Real app cards** — workflow/calendar/history read actual data (scheduler jobs, `~/.openswarm/runs.jsonl`).
7. Polish: monochrome dock icons; the two documented minor module issues.

**Backend / agent areas**
- **Isolate the subscription model from my global config**: `claude -p` currently inherits `~/.claude/CLAUDE.md` + hooks (superpowers/OMC), so the Atelier agent sometimes references them. Make the `claude -p` call use a clean config dir that still reads the Max OAuth credentials (`~/.claude/.credentials.json`), so the agent is pure Atelier.
- Expand the lite agent toward the full agency (or wire the real specialists / publishing / scheduler into the app).

**Packaging**
- Bundle the Python backend (PyInstaller/py2app) + venv into `Atelier.app` so it's portable and doesn't depend on `~/Desktop/openswarm`. Add code signing.

**Deep research to do FIRST (before building the hard ones)**
- How OpenSwarm implements embedded browser + agent-driven webviews: read `/Applications/OpenSwarm.app/Contents/Resources/frontend/*.bundle.js` + `Resources/app.asar` (`main.js`) for `BROWSER_PARTITION`, webview enablement, and the agent-drives-browser flow.
- Multiple-dashboards data model + thumbnail generation (they use `html2canvas`).
- How to isolate `claude -p` from the global `CLAUDE.md`/hooks while keeping the Max OAuth (Claude Code config-dir / settings flags).
- PyInstaller/py2app to bundle the venv + backend into the `.app`.

Use the **Workflow tool** for multi-part builds (scan → foundation → parallel feature modules → review), and screenshot-verify UI work in a browser before rebuilding the `.app`. Default next step if unspecified: **multiple dashboards + the `/metrics` live-data wiring**.

---
