# Atelier Roadmap — the spine

Single source of truth for the autonomous build loop. Read this in full at the start of every round, plus `git log --oneline -30` and the DECISIONS + SUPERSEDED sections, before choosing work. Full method: `~/Desktop/AI Brain/Reference/Atelier Build Loop.md`. RESUME.md, BACKLOG.md, docs/UI-BACKLOG.md are idea-INPUTS, not the roadmap.

## VISION (frozen — only Jason edits this; the loop may NEVER redefine it)

Atelier is the **glass cockpit for a personal AI workforce** — the one spatial place where you assemble teams of agents, WATCH long-running autonomous work happen in real time, STEER it on the canvas, and have it actually SHIP real deliverables end to end, on a flat subscription with zero per-token anxiety.

**Hero workflow (the one demo everything serves):** from an empty canvas, drop a goal → an agent RESEARCHES it in the live embedded browser → PRODUCES a real deliverable → and actually PUBLISHES it to a real destination — watched and steered on the canvas in real time.

**Gate for all work:** does this make a currently-broken step of the hero workflow (research | make | publish | watch-and-steer) possible, more reliable, or more watchable, end to end? If you can't answer yes in one sentence, don't build it.

## STATE (rewrite each round)

- Last live-verified commit: r33 Click/Type (operate the linked page), branch `swarm-extensions`, pushed to `origin/swarm-extensions`.
- Backend tests: **685 passing** (only ratchets up; +10 for Click/Type round-trip, on top of r32's +13). Frontend gated by `node --check` + live Electron screenshot-verify.
- Installed app: `/Applications/Atelier.app`, healthy on the Claude Max subscription (`/health` 200); `/tools` lists `ReadPage` + `Click` + `Type` (all agent sessions).
- **Hero-workflow completion today (rough): ~68%.** research ✅ (OpenBrowser/NavigateBrowser + **ReadPage** + Deep Research + WebSearch) · make ✅ (Documents/decks/notes/mini-apps, keyless) · **publish/operate 🟡→ the agent can now OPEN, NAVIGATE, READ, and OPERATE a page (`Click` + `Type` fill forms + submit); the remaining gap to a real post is a logged-in destination + `UploadFile` for media, plus the last-mile "actually posted" confirmation** · watch-and-steer 🟡 (sub-agent arrows + live job cards + six widgets, but no first-class real-time activity view).
- **The computer-use loop is CLOSED for text**: OpenBrowser (r22) → ReadPage (r32, eyes) → Click/Type (r33, hands), all over one round-trip channel (`sess.browser_read`/`browser_act` + `POST /sessions/{id}/browser_result` + a req-keyed future; shared helper `_browser_roundtrip`). Live-proven: an agent typed a query into DuckDuckGo, clicked submit, and read back the real results.
- **Weakest link right now: the FIRST real end-to-end publish** — drive a logged-in browser card (per-card profiles, r30) to actually submit a post to one forgiving destination, capture the artifact. `UploadFile` (media) is the one missing operate primitive for image/video posts. Second weakest: the deep OpenSwarm workforce (8 specialist agents + Campaign meta-agent in `server.py`/`swarm.py`) does NOT run in `lite_server` — present but dark.

## NOW / NEXT / LATER (by theme)

### Theme: Deliver-and-Publish spine (the hero workflow) — PRIMARY
- **NOW** · First real publish (the actual hero-workflow payoff): with Click/Type/ReadPage in hand, drive a logged-in browser card to actually SUBMIT a post to one forgiving destination end to end, and capture the artifact (the posted item / a read-back confirmation). Reuse per-card browser profiles (r30) for the one-time manual login. Pick something forgiving first (a text post: a personal blog/CMS, a webhook-backed form, or a low-stakes forum), not a bot-hostile platform.
- **NOW** · `UploadFile`: the one missing operate primitive — let an agent attach a local file (a rendered image/video/doc) to a file input in the linked webview, reusing the `browser_act` round-trip (a new action kind + the webview file-chooser bridge). Needed for any media post.
- **NEXT** · Activate the real OpenSwarm workforce: wire the 8 specialist deliverable agents + the Campaign meta-agent (`server.py`/`swarm.py`) into the app's `lite_server` runtime so the deepest capability actually runs in the app. *Activation beats invention — grep before building.*
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
- ReadPage (r32) gates its RETURNED CONTENT on the page's real loaded host (`_agent_open_host_blocked`): it refuses to feed a loopback / private / link-local page's body to the model, closing the OpenBrowser→NavigateBrowser→ReadPage internal-read exfil chain. NavigateBrowser itself stays host-unrestricted on purpose (a user may drive their own localhost in a card they linked) — the gate lives on the read side so driving still works but the agent cannot slurp internal content. Click/Type/UploadFile, when built, MUST carry the same read/act-side host gate.
- ReadPage returns page text as clearly-framed UNTRUSTED data (prompt-injection surface, same class as the pre-existing linked-browser-context ride-along); the agent's tool blast radius is bounded (vault-write / web / canvas / token-gated Notion — no shell/fs). `sess.browser_read` is a single slot: a rare parallel double-ReadPage strands one call to its 25s timeout (safe, no corruption); a queue is the upgrade if it ever bites.
- Click/Type (r33) do not gate the ACTION (a user driving their own localhost form must keep working) but DO host-gate the one piece of data they hand back that could leak: Click's post-click URL is withheld when its host is loopback/private/link-local (`_act_result_text` runs `_agent_open_host_blocked` on it, exactly like ReadPage gates page content — an internal URL can carry session tokens in its query string). Type's ack echoes only the value the agent itself typed (no page data). `clickJs`/`typeJs` JSON-encode their selector/text into the injected script so a hostile value cannot break out of its string literal. When `UploadFile` is built it MUST reconsider this (a file path is a new exfil/read surface). [r33 review finding, fixed.]

## SUPERSEDED / REJECTED (don't re-propose)

- Rejected as commercial-clone machinery with no solo-user payoff: App Builder + its runtime, the 9Router embedded LLM gateway, MCP registry UI, deep-link/OAuth-connect/affiliate glue, CDP debugger attach, analytics/telemetry, auto-updater, crash watchdog, multi-window. (See `docs/UI-BACKLOG.md` + vault Analysis/Atelier Roadmap Research.)
- The old north star (OpenSwarm parity + six living widgets) is COMPLETE — not the objective anymore.

## Round log (last ~8; archive older to CHANGELOG.md)

- r33 Click/Type: agents OPERATE the linked page, not just read it. Two orchestra tools driving the webview by CSS selector (`Click(selector)`, `Type(selector, text)`) over a new `sess.browser_act` round-trip that REUSES r32's result channel (shared `_browser_read_waiters` + `POST browser_result`; factored a shared `_browser_roundtrip` helper, ReadPage refactored onto it). Frontend `apps.js` `browserAct` → `clickJs`/`typeJs` (args JSON-encoded, native value-setter so React/Vue inputs notice) via a shared `withReadyWebview`; `sessions.js handleBrowserAct` (seq-gated `lastActSeq`). Not host-gated (actions send data TO the page, return only app-authored acks + the field's own value, no page body). 685 tests. Live-verified: an agent typed a query into DuckDuckGo, clicked submit, and ReadPage'd the real results (screenshot).
- r32 ReadPage: the agent reads the linked browser's LIVE page text back into its context (Golden Task 5 done end-to-end). The first ROUND-TRIP orchestra tool — `sess.browser_read`={req,seq} + `POST /sessions/{id}/browser_result` + a req-keyed awaitable future (25s timeout); the card reads the webview via `executeJavaScript` innerText and posts it back. Frontend: `AtelierApps.browserReadPage` + `sessions.js handleBrowserRead` (seq-gated, waits past about:blank/attach). Adversarial review caught + fixed an SSRF-read chain (OpenBrowser public → NavigateBrowser to loopback/LAN → ReadPage exfil): ReadPage now gates returned content on the page's real host via `_agent_open_host_blocked`. 675 tests. Live-verified: agent quoted example.com's live first sentence verbatim through the full loop.
- r31 (`1b39a23`) loop → orchestration layer (marquee a Loop + orchestrator chat to re-run a whole layer on schedule).
- r30 (`a321af4`) per-card browser profiles + clean Chrome UA; Google embedded sign-in confirmed blocked by policy.
- browser Client-Hints consistency (`fe52b51`); posting design noted for future (`3827d5a`).
- r29 (`eded56f`) Workflow AI paywall scaffold (gate only). r28 (`686b39d`) external-agent connectors + packaging fix (`98c5536`).
- r27 (`5739a80`) customizable slash commands.
- Fixes: minimap drag smoothness (`4f7956b`), chat composer collapse-after-send (`8e61d55`).
- Meta: authored this ROADMAP + GOLDEN_TASKS + the wiki playbook (`Reference/Atelier Build Loop.md`) to seed the autonomous loop.
