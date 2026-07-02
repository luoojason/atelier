# Atelier — resume prompt

Paste the block below to pick up after a context clear.

---

Resume the **Atelier** project. Atelier is my fork of VRSEN/OpenSwarm at `~/Desktop/openswarm` (branch `swarm-extensions`), extended into a deliverable workforce **and a desktop app**, all running on my **Claude Max subscription** (zero API keys).

**Read these first for full state** (do not rebuild from scratch): the wiki page `Projects/OpenSwarm.md` in the Obsidian vault `~/Desktop/AI Brain`; and in the fork: `docs/EXTENSIONS.md`, `docs/UI-BACKLOG.md` (54 ranked OpenSwarm features), `BACKLOG.md`.

**Current state (through commit `1651ad6`)**
- **Agency** (Python, Agency Swarm): backlog #1–#12 + the Claude-subscription model backend (`claude_subscription_model.py`, `DEFAULT_MODEL=claude-cli`) + Campaign meta-agent. 241 tests.
- **Isolation is DONE and on by default in the app**: with `CLAUDE_ISOLATED=1`, `run_cli` adds `--safe-mode` + a fresh `CLAUDE_CONFIG_DIR` (`~/.atelier/claude-home`) + `CLAUDE_SECURESTORAGE_CONFIG_DIR=''` (empty string — undocumented; keeps Max OAuth on the default macOS Keychain item, so token refresh stays unified) + explicit `--model` (env `CLAUDE_CLI_MODEL`, default sonnet) + one no-login fallback retry. The app agent is pure Atelier — no global CLAUDE.md/hooks/superpowers/OMC bleed. Live-verified.
- **Desktop app** (`~/Desktop/openswarm/desktop/`, modular vanilla JS on `window.Atelier`): everything from before PLUS
  - **Multiple dashboards** (`app/boards.js`): named boards, create/rename/duplicate/delete/switch, sidebar list + all-boards panel with search, real thumbnails via a `capturePage` IPC (DIP-converted, 480w JPEG in localStorage). Per-board state = localStorage snapshot swap + `location.reload()` (in-place switch is the named upgrade path).
  - **Live data**: `lite_server.py` endpoints `/metrics` `/runs` `/jobs` `/notifications` (read-only, empty-shape on missing files, origin-gated CORS + 403 middleware; shared-secret header is the named upgrade). Widgets (metric/status/chart/list) have `source` + `field` config and poll every 15s; workflow/calendar/history app cards show real scheduler jobs + run ledger + notifications.
  - **Embedded browser cards**: real `<webview>` (partition `persist:atelier-browser`, preload stripped + nodeIntegration pinned off in `will-attach-webview`, popups denied, `window.open` → OS browser), URL normalize, back/forward/title/nav events, iframe fallback outside Electron. No tabs yet; OAuth popups not routed (denied) — both are named ceilings.
  - **Fit-to-view** (zoombar ⤢ + `Atelier.canvas.fitToView`), **⌘M** add-app, **Escape** close, ⌘K palette now spawns fully mounted+persisted widgets (core `spawnWidget` delegates to the widgets module).
- **Packaging is DONE — Atelier.app is portable** (506M, installed at `/Applications`): `desktop/scripts/build-python-env.sh` builds a python-build-standalone 3.13 env (271M, ad-hoc signed) into `desktop/build-staging/`; electron-builder `extraResources` ship it at `Resources/python-env` plus the backend source set at `Resources/backend`; `main.js` resolves both via `app.isPackaged`. Verified: backend spawns from inside the .app (health ~6s), live `/chat` on the subscription with the isolated config. External deps that stay on the machine: the `claude` CLI (logged into Max) and network.
- **To rebuild the .app**: `desktop/scripts/build-python-env.sh` (once, or after backend dep changes) → `cd desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir` → `rm -rf /Applications/Atelier.app && cp -R dist/mac-arm64/Atelier.app /Applications/`. Dev iteration: edit files, `npm start` (uses the repo + `.venv-ext` directly).
- **Verification harness**: `playwright-core` is a desktop devDependency; `_electron.launch({args:['main.js'], executablePath: require('electron')})` drives the real app (webview, thumbnails). Browser-phase testing: serve `desktop/` statically + run `lite_server.py` on 8765.

**Round 9 done (2026-07-01, commits `b46fac9`, `117c37b`)**: packaging hardening (single-instance lock + stale-8765 kill + `~/.atelier/logs/backend.log` + auto-respawn — fixed a live "backend could not start"); roadmap research at vault `Analysis/Atelier Roadmap Research.md`; and the **scheduler daemon is wired** — the app spawns `scheduler/scheduler.py` firing 3 vault jobs (morning-brief/project-rollup/overnight-digest) at a new isolated `POST /open-swarm/get_response` compat route on lite_server, with `catch_up` + `builtin:digest` + lenient loading. `~/.atelier/jobs.yaml` is the user-editable jobs file. 261 tests; verified live (daemon spawns, catch-up fires, runs.jsonl populates, /metrics + History show real data).

**THE NEXT TASK — bridge reliability (roadmap #9).** Measured: the agency-swarm → `claude -p` tool bridge is only ~60% reliable (the model intermittently attempts a native tool call → `claude -p` returns "No such tool available" instead of the fenced-JSON the bridge parses). The zero-agent digest job is 100% reliable; the 2 agent jobs are not, so the Morning Brief fails ~40% of mornings. Fix: migrate lite_server's single lite agent to the official **`claude-agent-sdk`** (0.2.110, VERIFIED live on the Max subscription under the isolation env with in-process `@tool` MCP servers) — native tool_use is reliable and also unlocks streaming + persistent sessions. Keep `claude_subscription_model.py` for the heavy multi-agent swarm only.

**Next work areas** (see `docs/UI-BACKLOG.md` for the full 54):
1. Markdown note editor in the note card (CodeMirror-class; currently a plain textarea).
2. Browser card tabs + OAuth popup routing (`webview-new-window` IPC → new card, child-window allow for OAuth — OpenSwarm's exact mechanics are documented in the research notes in the wiki page).
3. In-place board switch (drop the reload), marquee multi-select, tidy/auto-arrange, working minimap.
4. Shared-secret header between app and lite_server (replaces origin gating).
5. Wire the scheduler daemon + real runs into the app (runs.jsonl is empty until jobs fire), Campaign progress card, agent/chat multi-card.
6. Code signing with a real Developer ID + notarization (ad-hoc now; entitlements + inside-out signing notes are in the wiki research section).

Use the **Workflow tool** for multi-part builds (parallel disjoint-file agents against a fixed API contract → adversarial review → fixer worked very well), and screenshot-verify with the Playwright harness before rebuilding the .app.

---
