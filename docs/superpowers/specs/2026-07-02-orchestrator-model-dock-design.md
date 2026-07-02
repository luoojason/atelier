# Design: Orchestrator chats, per-chat models, and dock cleanup

- **Date:** 2026-07-02
- **Status:** Approved (design); ready for implementation plan
- **Branch:** `swarm-extensions`
- **Scope owner:** Atelier desktop app (`desktop/`) + lite subscription backend (`lite_server.py`)

## Context

Atelier's desktop app is an Electron "infinite canvas" of cards. Chat happens two ways:

- A **permanent main chat card** baked into `desktop/index.html:74-92` — a bare `textarea#input` (placeholder `"Message Atelier…"`) streaming over `POST /chat/stream` with a single long-lived client (`desktop/app/core.js:806`).
- **Agent cards** — session-based conversations spawned by the ✳ dock button (`A.spawnApp('agent')`, `desktop/app/sessions.js:818`), each its own `POST /sessions` conversation with `parent_id`/`depth` plumbing, an auto-reveal sweep, and connector arrows.

Three gaps motivate this work:

1. The dock (`desktop/index.html:97-105`) has redundancy: `DOCK_MAP` routes **both** ▦ Apps and 🗒 Notes to `'note'` (`desktop/app/apps.js:1090-1092`), and 💬 Chat only refocuses the one input instead of creating chats (`desktop/app/apps.js:1102`).
2. There's no user gesture to make one chat **orchestrate** another. The only link gesture (`desktop/app/link.js`) connects a browser card to an agent card and rejects agent+agent pairs. Orchestrator→subagent delegation exists in the engine but is **model-driven only** (`SpawnAgent`, `lite_server.py:1814`) and cannot target a user-chosen existing card.
3. Model choice is **global** (`_resolved_model()`, `lite_server.py:181`; `POST /config/model`, allowlist `{sonnet,opus,haiku}`), not per-chat.

## Goal

- Clean up the dock; make 💬 Chat spawn new (linkable) chats.
- Add a **per-chat model picker** to every composer.
- Add a **"govern" select-mode** to each composer that designates which agent cards a chat orchestrates.
- Wire those links to **real delegation**: an orchestrator's model sends subtasks to its governed cards and collects results.

## Approved decisions

1. **Remove the ✳ Agent dock button** — 💬 Chat replaces it as the new-chat trigger.
2. **One orchestrator per subagent** — a card has a single `parent_id`; re-governing moves it.
3. **v1 delegation lives on session/agent cards.** The permanent main chat gets the model picker but not govern/delegate; the user spawns a chat card and uses it as the orchestrator. Wiring the main `/chat` turn to orchestrate is a deferred follow-up.

---

## Part A — Dock cleanup

**Files:** `desktop/index.html`, `desktop/app/apps.js`

- **Dedupe notes.** In `DOCK_MAP` (`apps.js:1090-1092`), stop mapping `apps` → `'note'`. Repoint the ▦ **Apps** button to open the ⌘K command palette (`desktop/app/palette.js`). Keep 🗒 **Notes** → `'note'`.
- **Chat spawns chats.** Change the 💬 Chat handler (`apps.js:1102`) from "focus `#input`" to spawn a new agent/session card via the same path ✳ uses (`A.spawnApp('agent')`).
- **Remove ✳ Agent.** Delete the ✳ button from `index.html:103` and drop its wiring in `sessions.js:813-819` (fold its spawn into the 💬 handler). Final dock: 💬 Chat · ▦ Apps · 🌐 Browser · ↺ Campaign · 🗒 Notes · 🕘 History.

**Acceptance:** ▦ Apps opens the palette (not a note); 💬 Chat spawns a fresh chat card each press; no ✳ button; boot has no console errors.

---

## Part B — Per-chat model picker

Model families are the existing allowlist `{sonnet, opus, haiku}`. Frontend labels map: **Claude Opus 4.8 → `opus`**, **Sonnet → `sonnet`**, **Haiku → `haiku`**.

### Main chat
The main chat uses the long-lived client that `POST /config/model` already resets (`test_model_picker.py` contract). Its picker simply calls the **existing** `POST /config/model` — no new backend. On success (`{"ok":true,"model":...}`) the dropdown reflects the choice; `GET /config` provides the initial value.

### Agent cards (new per-session override)
- **Backend:** add `model: str | None = None` to `_AgentSession` (`lite_server.py:1523-1545`). Accept optional `model` in `SessionCreateRequest` (`lite_server.py:1693`, allowlist-gated → 400 `{"error":"unknown model"}` on junk). Add `POST /sessions/{id}/model {model}` reusing the same allowlist. `build_options`/`_run_session_turn` resolve `session.model or _resolved_model()` (`lite_server.py:181,199,1632`). Surface `model` in `GET /sessions/{id}` (`lite_server.py:1732`).
- **Frontend:** a shared helper mounts a model `▾` dropdown into every composer. For the main chat it targets `/config/model`; for agent cards it targets `/sessions/{id}/model` and passes `model` on the initial `POST /sessions`. Default shown = the resolved model (session override else global).

**Acceptance:** setting an agent card to Haiku and sending a turn runs on `haiku` (assert via `build_options`), independent of the global model and of other cards; junk model → 400; main-chat picker persists via `/config/model`.

---

## Part C — Govern select-mode (the gesture)

**Files:** new `desktop/app/govern.js`; `desktop/app/chatcontrols.js` (shared mount); `desktop/app/sessions.js` (redraw on reveal). `link.js` is untouched.

- Each composer gains a **target-cursor button** that toggles "govern mode" **for that chat**.
- While active: agent cards on the canvas highlight; clicking one **toggles** it as a governed subagent of the active chat.
- A governed card shows as a **chip** in the composer (with ✕ to remove) and a persistent **arrow** drawn orchestrator→subagent via `A.arrows.link(orchestratorEl, childEl)` (`desktop/app/arrows.js:188`, published `:240`).
- Toggling on calls the govern endpoint (Part D) and draws the arrow; toggling off (chip ✕ or re-click) calls unlink and removes the arrow. Exit govern mode via the button again or `Esc`.
- `govern.js` mirrors `link.js`'s module contract (loads after `arrows.js`/`sessions.js`; guards `window.Atelier`; publishes `window.Atelier.govern` with `childrenOf(el)`, `unlink(parentEl, childEl)`, `count()`; ships a `console.assert` self-check and a `── MANUAL TEST ──` block).

**Targets are always agent (session) cards** — they carry the ids/parent plumbing. The main chat cannot be a subagent, and in v1 is not an orchestrator (decision 3).

**Acceptance:** entering govern mode on Chat A and clicking Chat B draws A→B, adds a "B" chip to A's composer, and persists B's `parent_id=A` on the backend; ✕ removes the link and arrow.

---

## Part D — Backend governance links

**File:** `lite_server.py`

- **New** `POST /sessions/{id}/govern {child_id}`: set `child.parent_id = id`, `child.depth = parent.depth + 1` (`_AgentSession`, `lite_server.py:1544-1545`).
- **New** `DELETE /sessions/{id}/govern/{child_id}`: clear the child's `parent_id`/`depth`.
- **Validation (all → 400 with a specific `error`):** unknown session; self-link (`id == child_id`); **cycle** (walk the parent chain — linking must not make `id` a descendant of `child_id`); `_MAX_CHILDREN=4` per parent (`lite_server.py:1791`); **depth cap** (default 3) to bound chains.
- **Persistence is free:** `GET /sessions` already returns `parent_id`/`depth` (`lite_server.py:1715-1729`) and the frontend sweep (`SWEEP_MS`, `sessions.js:197`) already auto-reveals children and redraws arrows by `parent_id`. So governance **survives reload and board switches** — unlike the ephemeral browser links.

**Acceptance:** govern/ungovern set and clear `parent_id`; self-link, cycle, over-cap, and over-depth are each rejected with a distinct error; after a UI reload the sweep re-reveals the arrow.

---

## Part E — Real delegation

**File:** `lite_server.py` (+ `shared_instructions`/system-prompt text)

- Add a **`DelegateToSubagent(subagent, task)`** SDK tool alongside the existing `SpawnAgent`/`CheckAgent` (`_orchestra_tools`, `lite_server.py:1804-1871`). Unlike `SpawnAgent` (which creates a *new* child), `DelegateToSubagent` targets an **existing governed child** by id/name: it runs a turn on that child session via `_run_session_turn` (`lite_server.py:1632`), the child card streams the delegated task + reply through the normal poll, and the tool returns the child's result to the orchestrator. `CheckAgent` is reused to poll.
- **Attach condition:** `build_options` attaches the delegation tool + a system-prompt line listing the session's governed children **whenever the session has ≥1 child** (`parent_id` back-reference), not only at `depth==0`. The existing `SpawnAgent` depth-0 gate (`lite_server.py:1666`) is unchanged for backward compatibility.
- **Caps:** per-parent `_MAX_CHILDREN=4`; global depth cap (Part D) prevents runaway recursion; chained orchestration (A→B→C) is allowed within the depth cap.

**Acceptance:** with B governed by A, sending A a task that needs a subtask results in a `DelegateToSubagent` call that runs a turn on B (visible in B's card) and returns B's output to A; caps and depth are enforced.

---

## Data flow — delegation turn

1. User types a task in orchestrator card A → `POST /sessions/{A}/message`.
2. `_run_session_turn(A)` builds options that include `DelegateToSubagent` + a note naming A's governed children.
3. A's model calls `DelegateToSubagent(B, subtask)` → backend runs `_run_session_turn(B, subtask)`.
4. B's card (already on canvas) streams the subtask + reply via its existing 1.5s poll; the tool returns B's result to A.
5. A synthesizes and replies to the user.

## Error handling / edge cases

- **Card lifecycle:** closing an orchestrator ungoverns its children (they persist, ungoverned); closing a subagent removes its link + arrow (reuse the `card:removed` teardown pattern from `link.js:159`).
- **Re-govern:** a child already governed is moved to the new parent (single-parent invariant), old arrow removed first.
- **Backend down / 404:** govern actions surface a toast and no-op (match `sessions.js`/`toolinspector.js` offline behavior); no client-side link is kept without a backend `parent_id`.
- **Model junk / not allowlisted:** 400 `{"error":"unknown model"}`; the dropdown reverts to the prior value.

## Testing

Backend is `pytest` under `tests/` (run via `.venv-ext/bin/python -m pytest -q`). Frontend has **no** automated harness (`desktop/package.json` has only `start`/`dist`); frontend modules use a `console.assert` self-check + a documented `── MANUAL TEST ──` block, per `link.js`.

- **`tests/test_lite_sessions.py`** — extend: `POST/DELETE /sessions/{id}/govern` (set/clear `parent_id`), self-link/cycle/cap/depth rejections; `model` on `SessionCreateRequest` + `POST /sessions/{id}/model` (allowlist gate); `model` surfaced in `GET /sessions/{id}`.
- **`tests/test_subagents.py`** — extend: `DelegateToSubagent` routes a turn to the existing governed child and returns its result; attach condition (tool present iff ≥1 child); depth/child caps.
- **`tests/test_model_picker.py`** — extend: `session.model` overrides `_resolved_model()` in `build_options`; global `/config/model` path unchanged.
- **Frontend:** `govern.js` and `chatcontrols.js` each ship a self-check + manual-test block; add manual-test steps for dock changes (Part A), the model dropdown, and the govern gesture.

## Out of scope / follow-ups

- **Main chat as orchestrator** (govern/delegate from the `/chat` turn via a sentinel or by migrating the main chat to a session) — deferred (decision 3).
- **Full composer redesign** (agent/persona picker, thinking mode, `@context`, `/commands`, attach, mic) — separate effort; this spec adds only the model picker + govern button to the existing composer.
- **Knowledge-base memory (Notion/Obsidian) connectors** — separate spec; audit the existing memory/vault layer first (`test_vault_memory.py`, `shared_tools/`, ATELIER.md "live vault search/read/write").

## Build order

1. **A** Dock cleanup → 2. **B** Model picker → 3. **C+D** Govern gesture + backend links → 4. **E** Delegation. Each phase is independently testable and shippable.
