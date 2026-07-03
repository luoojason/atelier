# Atelier Roadmap — the spine

Single source of truth for the autonomous build loop. Read this in full at the start of every round, plus `git log --oneline -30` and the DECISIONS + SUPERSEDED sections, before choosing work. Full method: `~/Desktop/AI Brain/Reference/Atelier Build Loop.md`. RESUME.md, BACKLOG.md, docs/UI-BACKLOG.md are idea-INPUTS, not the roadmap.

## VISION (frozen — only Jason edits this; the loop may NEVER redefine it)

Atelier is the **glass cockpit for a personal AI workforce** — the one spatial place where you assemble teams of agents, WATCH long-running autonomous work happen in real time, STEER it on the canvas, and have it actually SHIP real deliverables end to end, on a flat subscription with zero per-token anxiety.

**Hero workflow (the one demo everything serves):** from an empty canvas, drop a goal → an agent RESEARCHES it in the live embedded browser → PRODUCES a real deliverable → and actually PUBLISHES it to a real destination — watched and steered on the canvas in real time.

**Gate for all work:** does this make a currently-broken step of the hero workflow (research | make | publish | watch-and-steer) possible, more reliable, or more watchable, end to end? If you can't answer yes in one sentence, don't build it.

## STATE (rewrite each round)

- Last live-verified commit: `8e61d55` (composer collapse fix), branch `swarm-extensions`, HEAD pushed to `origin/swarm-extensions`.
- Backend tests: **662 passing** (only ratchets up). Frontend gated by `node --check` + live Electron screenshot-verify.
- Installed app: `/Applications/Atelier.app`, healthy on the Claude Max subscription (`/health` 200).
- **Hero-workflow completion today (rough): ~55%.** research ✅ (agent-driven browser: OpenBrowser/NavigateBrowser + Deep Research + WebSearch) · make ✅ (Documents/decks/notes/mini-apps, all keyless) · **publish ❌ (the agent can OPEN/NAVIGATE a browser but cannot OPERATE it — no click/type/upload/read — so nothing actually gets posted)** · watch-and-steer 🟡 (sub-agent arrows + live job cards + six widgets exist, but no first-class real-time activity view).
- **Weakest link right now: the publish step** (computer-use in the webview). Second weakest: the deep OpenSwarm workforce (8 specialist agents + Campaign meta-agent in `server.py`/`swarm.py`) does NOT run in `lite_server` — present but dark.

## NOW / NEXT / LATER (by theme)

### Theme: Deliver-and-Publish spine (the hero workflow) — PRIMARY
- **NOW** · Activate the real OpenSwarm workforce: wire the 8 specialist deliverable agents + the Campaign meta-agent (`server.py`/`swarm.py`) into the app's `lite_server` runtime so the deepest capability actually runs in the app. *Activation beats invention — grep before building.*
- **NOW** · Close the computer-use loop: give agents `ReadPage` / `Click` / `Type` / `UploadFile` (+ `Screenshot`) inside the embedded webview so they OPERATE a page, not just open it. This is the load-bearing unblock for publish.
- **NEXT** · First real publish: drive a logged-in browser card to post/submit to one real destination end to end (start with something forgiving), with a real artifact captured. Reuse per-card browser profiles (already shipped).
- **NEXT** · Hybrid publish connectors where APIs are sane (per RESUME backlog item 4): a per-platform token in Settings (reuse the external-agents/Notion settings pattern).

### Theme: Watch-and-steer (live activity)
- **NEXT** · A first-class real-time activity view: watch an agent drive the browser live + orchestrator↔sub-agent messages streaming, with steer/pause/redirect. Deepen the existing widgets/arrows/job-cards rather than inventing a parallel surface.

### Theme: Cohesion & quality (consolidation targets — for the every-4th round)
- Kill reachable stub/dead-end cards and the premium "coming soon" surface (make real or delete; do NOT feed the paywall).
- Split the god-modules (`sessions.js`/`apps.js`/`core.js`/`views.js`, ~55-60 KB each); unify hardcoded hex to the CSS design tokens; collapse fragmented `<style>` blocks.
- Drain documented "accepted follow-ups": yaml comments lost on jobs write, open prompt-injection surfaces, selection-event contract edge, non-incremental streaming.

### LATER (do NOT touch until the single-operator research→make→publish spine runs end to end)
- Narrated-video deliverable (reuse `~/Content/reddit-shorts`); key-gated add-ons (image/video gen, Composio VA); auto-write memory / cross-session learning; multi-user, Developer-ID signing + notarization, real monetization.

## DECISIONS (append-only; honor, do not re-litigate)

- Single-user, local `claude` CLI logged into Max; dual-auth (subscription default via isolated CLI OAuth, or an optional stored API key). Isolated `CLAUDE_CONFIG_DIR`, per-launch shared-secret token on mutating routes, 0600 config.
- Frontend is vanilla JS on `window.Atelier`, no framework. State persists per-board in localStorage.
- Sub-agent orchestration is intentionally shallow: depth cap 1, child cap ~4 (Max rate limits are real).
- Per-card browser profiles (isolated partitions). Google embedded account sign-in is blocked by Google policy — not a bug; use "Sign in with Google" OAuth popups / cookie-import later, or the platform API. The CDP-debugger-attach Client-Hints hack is REJECTED (breaks the card's DevTools + hang risk).
- The premium/paywall path is a visual scaffold only — no product, pricing, or payment. Do not build monetization until Jason decides.
- The 54 UI-BACKLOG rows are DONE (Phase A/B complete) — do not re-skin or re-litigate them.

## SUPERSEDED / REJECTED (don't re-propose)

- Rejected as commercial-clone machinery with no solo-user payoff: App Builder + its runtime, the 9Router embedded LLM gateway, MCP registry UI, deep-link/OAuth-connect/affiliate glue, CDP debugger attach, analytics/telemetry, auto-updater, crash watchdog, multi-window. (See `docs/UI-BACKLOG.md` + vault Analysis/Atelier Roadmap Research.)
- The old north star (OpenSwarm parity + six living widgets) is COMPLETE — not the objective anymore.

## Round log (last ~8; archive older to CHANGELOG.md)

- r31 (`1b39a23`) loop → orchestration layer (marquee a Loop + orchestrator chat to re-run a whole layer on schedule).
- r30 (`a321af4`) per-card browser profiles + clean Chrome UA; Google embedded sign-in confirmed blocked by policy.
- browser Client-Hints consistency (`fe52b51`); posting design noted for future (`3827d5a`).
- r29 (`eded56f`) Workflow AI paywall scaffold (gate only). r28 (`686b39d`) external-agent connectors + packaging fix (`98c5536`).
- r27 (`5739a80`) customizable slash commands.
- Fixes: minimap drag smoothness (`4f7956b`), chat composer collapse-after-send (`8e61d55`).
- Meta: authored this ROADMAP + GOLDEN_TASKS + the wiki playbook (`Reference/Atelier Build Loop.md`) to seed the autonomous loop.
