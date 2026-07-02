# Orchestrator Chats, Per-Chat Model & Dock Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up the Atelier dock, add a per-chat model picker to every composer, add a govern select-mode that designates which agent cards a chat orchestrates, and wire those links to real delegation.

**Architecture:** Atelier is an Electron infinite-canvas app (vanilla JS, no build step) talking to a FastAPI "lite" subscription backend (`lite_server.py`) over `http://127.0.0.1:8765`. Govern links are stored on the backend as each session's `parent_id`/`depth`, so governance survives reload and board switches (the `sessions.js` sweep re-reveals arrows). Real delegation routes a turn to an existing governed child via a new `DelegateToSubagent` SDK tool, and a per-chat model override resolves as `session.model or _resolved_model()` inside `build_options`.

**Tech Stack:** Python 3 / FastAPI / claude-agent-sdk / pytest (.venv-ext); Electron + vanilla JS (no build step, no frontend test harness).

## Global Constraints
- Commit style: conventional commits (feat:/fix:/docs:/test:/refactor:); NO emojis; NO AI attribution trailers.
- Backend tests: .venv-ext/bin/python -m pytest -q tests/<file> -v
- Frontend: no automated harness — each module ships a console.assert self-check + a "── MANUAL TEST ──" block (mirror desktop/app/link.js).
- Model allowlist: {sonnet, opus, haiku}; UI labels Claude Opus 4.8/Sonnet/Haiku.
- One orchestrator per subagent (single parent_id); _MAX_CHILDREN=4; _MAX_DEPTH=3.
- Frontend load order: new modules after arrows.js + sessions.js in index.html; guard window.Atelier.

## File Structure

| File | Created/Modified | Responsibility |
|------|------------------|----------------|
| `desktop/app/palette.js` | Modified | Publish `window.Atelier.palette = { open, close, toggle }` so other modules can open the ⌘K palette. |
| `desktop/app/apps.js` | Modified | Repoint dock ▦ Apps to the palette and 💬 Chat to spawn a fresh agent card; drop `apps` from `DOCK_MAP`. |
| `desktop/index.html` | Modified | Remove the ✳ Agent dock button; add the `chatcontrols.js` and `govern.js` script tags. |
| `desktop/app/sessions.js` | Modified | Remove the ✳ Agent dock wiring; mount the per-session model picker on each agent card. |
| `desktop/app/core.js` | Modified | Mount the shared model picker on the main chat composer (scope `'main'`). |
| `desktop/app/chatcontrols.js` | Created | Shared per-composer control strip: model picker (Part B) + govern button/chip/gesture (Part C). |
| `desktop/app/govern.js` | Created | Govern registry + backend link (POST/DELETE `/sessions/{id}/govern`) + arrow lifecycle. |
| `lite_server.py` | Modified | Per-session `model`, `POST /sessions/{id}/model`, govern endpoints + cycle helper, `DelegateToSubagent` tool + attach condition. |
| `tests/test_model_picker.py` | Modified | `build_options(model=…)` honors an explicit per-session model; global path unchanged. |
| `tests/test_lite_sessions.py` | Modified | Session-model wiring/allowlist, `POST /sessions/{id}/model`, `model` in `GET /sessions/{id}`, govern cycle helper + POST/DELETE govern branches. |
| `tests/test_subagents.py` | Modified | `DelegateToSubagent` routing/resolution/caps + `build_options` attach-condition tests. |

---

## Part A: Dock cleanup

Frontend-only (vanilla JS, no build step, no automated harness). Every task's "test" is the module's `console.assert` self-check plus a `── MANUAL TEST ──` block. No pytest. Commits use conventional-commit style, no emojis, no AI-attribution trailers.

---

### Task 1 — Publish a public palette-open API from `palette.js`

The ▦ Apps dock button (Task 2) needs to open the ⌘K command palette, but `palette.js` currently keeps `open`/`close`/`toggle` private inside its IIFE and exposes nothing on `window.Atelier`. Publish a tiny API so other modules can open the palette without duplicating the ⌘K keydown wiring. `palette.js` loads after `apps.js`, so Task 2 must read this lazily (at click time) and guard it.

**Files:**
- Modify `desktop/app/palette.js` — add the API publish just after `function toggle()` (~line 366, before the `⌘K` keydown listener); extend the self-check (~lines 397-407); add a `── MANUAL TEST ──` note to the header docstring.

**Interfaces:**
- Produces: `window.Atelier.palette = { open, close, toggle }` — `open(prefill?: string) -> void`, `close() -> void`, `toggle() -> void`. These are the module's existing local functions, published by reference.
- Consumes: `window.Atelier` (already the module's `A`).

Steps:

- [ ] **Step 1: Publish the API.** In `desktop/app/palette.js`, immediately after the existing `function toggle() { isOpen ? close() : open(); }` line and before the `// ── ⌘K / Ctrl+K global shortcut ──` comment, insert:
```js
  // ── public surface: let other modules (e.g. the ▦ Apps dock button in
  //    apps.js) open the palette without re-implementing the ⌘K wiring.
  //    apps.js loads BEFORE this file, so it reads A.palette lazily at click
  //    time and guards it — a 404 of this module simply leaves ▦ Apps inert.
  A.palette = { open, close, toggle };
```

- [ ] **Step 2: Extend the self-check.** In the `selfCheck` IIFE at the bottom of `desktop/app/palette.js`, add a palette-API assertion and fold it into the `ok` gate. Replace:
```js
    const hasThemeEvt = typeof A.bus.emit === 'function';
    const ok = hasNote && hasWidget && hasThemeEvt && THEMES.length >= 1;
    console.assert(hasNote, '[palette] expected an "Add app: Note" command');
    console.assert(hasWidget, '[palette] expected an "Add widget…" command');
```
with:
```js
    const hasThemeEvt = typeof A.bus.emit === 'function';
    const apiOk = !!A.palette
      && typeof A.palette.open === 'function'
      && typeof A.palette.close === 'function'
      && typeof A.palette.toggle === 'function';
    const ok = hasNote && hasWidget && hasThemeEvt && apiOk && THEMES.length >= 1;
    console.assert(hasNote, '[palette] expected an "Add app: Note" command');
    console.assert(hasWidget, '[palette] expected an "Add widget…" command');
    console.assert(apiOk, '[palette] window.Atelier.palette API incomplete:', A.palette);
```

- [ ] **Step 3: Document the manual test.** Append to the header docstring of `desktop/app/palette.js` (inside the top block comment, mirroring `link.js`'s `── MANUAL TEST ──` structure) a numbered block:
```
   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. `npm start` in desktop/. Console: expect
      "[palette] ready — self-check passed (… commands, ⌘K to open)."
   2. DevTools console: `window.Atelier.palette.open()` — the palette overlay
      opens, input focused. `window.Atelier.palette.close()` — it closes.
   3. `typeof window.Atelier.palette.toggle` is "function".
```

- [ ] **Step 4: Manually verify.** Run `npm start` in `desktop/`, open DevTools, confirm the self-check line prints with no assertion failures, and that `window.Atelier.palette.open()` opens the overlay and `.close()` dismisses it.

- [ ] **Step 5: Commit.** `feat: publish window.Atelier.palette open/close/toggle API`

---

### Task 2 — Repoint ▦ Apps to the palette and make 💬 Chat spawn a chat card (`apps.js`)

`DOCK_MAP` currently routes both `apps` and `notes` to `'note'`, and the 💬 Chat branch only refocuses `#input`. Drop `apps` from `DOCK_MAP`, add an `apps` branch that opens the palette (Task 1's API), and change the `chat` branch to spawn a fresh agent/session card via the same path the old ✳ button used. `A.spawnApp` and `A.palette` are both read at click time, so load order (apps.js before palette.js/sessions.js) is safe.

**Files:**
- Modify `desktop/app/apps.js` — `DOCK_MAP` (lines 1090-1093); the dock click handler inside `wireDock` (lines 1098-1105); the `selfCheck` dock assertions (lines 1162-1163).

**Interfaces:**
- Consumes: `window.Atelier.palette.open()` (from Task 1); `window.Atelier.spawnApp('agent')` (the registered agent app type from `sessions.js`); `fresh.getAttribute('title')`.
- Produces: no new public surface (dock behavior only).

Steps:

- [ ] **Step 1: Drop `apps` from `DOCK_MAP`.** In `desktop/app/apps.js`, replace:
```js
  const DOCK_MAP = {
    apps: 'note', browser: 'browser', campaign: 'workflow',
    notes: 'note', history: 'history', calendar: 'calendar',
  };
```
with:
```js
  const DOCK_MAP = {
    browser: 'browser', campaign: 'workflow',
    notes: 'note', history: 'history', calendar: 'calendar',
  };
```

- [ ] **Step 2: Rewrite the chat + apps branches of the dock click handler.** In the `wireDock` IIFE, replace:
```js
        const t = (fresh.getAttribute('title') || '').toLowerCase();
        if (t === 'chat') { const i = document.getElementById('input'); if (i) i.focus(); return; }
        const type = DOCK_MAP[t];
        if (type) makeApp(type, {});
```
with:
```js
        const t = (fresh.getAttribute('title') || '').toLowerCase();
        // 💬 Chat spawns a fresh agent/session card (the old ✳ Agent path).
        if (t === 'chat') { if (typeof A.spawnApp === 'function') A.spawnApp('agent'); return; }
        // ▦ Apps opens the ⌘K command palette. Read lazily + guarded: palette.js
        // loads AFTER us, so A.palette is absent at parse but present at click.
        if (t === 'apps') { if (A.palette && typeof A.palette.open === 'function') A.palette.open(); return; }
        const type = DOCK_MAP[t];
        if (type) makeApp(type, {});
```

- [ ] **Step 3: Update the self-check.** In the `selfCheck` IIFE, after the existing dock-count assertion, replace:
```js
    const dock = document.querySelectorAll('.dock-btn');
    console.assert(dock.length >= 6, '[apps] expected 6 dock buttons, got', dock.length);
```
with:
```js
    const dock = document.querySelectorAll('.dock-btn');
    console.assert(dock.length >= 6, '[apps] expected 6 dock buttons, got', dock.length);
    console.assert(!('apps' in DOCK_MAP), '[apps] ▦ Apps must no longer map to a note type');
```

- [ ] **Step 4: Document the manual test.** Append a `── MANUAL TEST ──` numbered block to the `apps.js` header docstring (mirroring `link.js`):
```
   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up + `npm start` in desktop/. Console: expect the apps self-check
      to pass (no assertion warnings).
   2. Click ▦ Apps in the dock — the ⌘K command palette overlay opens (NOT a
      new note card).
   3. Click 💬 Chat — a fresh agent/session card appears on the canvas; click it
      again — a second card appears (one per press).
   4. Click 🗒 Notes — still spawns a note card (unchanged).
```

- [ ] **Step 5: Manually verify.** Run `npm start`, confirm ▦ Apps opens the palette, each 💬 Chat press spawns a new agent card, 🗒 Notes still makes a note, and the console shows no assertion failures.

- [ ] **Step 6: Commit.** `feat: repoint dock ▦ Apps to palette and 💬 Chat to spawn agent cards`

---

### Task 3 — Remove the ✳ Agent button and its wiring (`index.html` + `sessions.js`)

With 💬 Chat now spawning agent cards (Task 2), the ✳ Agent dock button is redundant. Delete the button from `index.html` and remove its click wiring in `sessions.js`, and flip the `sessions.js` self-check (which currently *requires* the Agent button to exist) to require its *absence* plus a present Chat button. Final dock: 💬 Chat · ▦ Apps · 🌐 Browser · ↺ Campaign · 🗒 Notes · 🕘 History.

**Files:**
- Modify `desktop/index.html` — delete the ✳ button (line 103).
- Modify `desktop/app/sessions.js` — remove the `wireDock` IIFE (lines 813-819); update the `selfCheck` Agent-button assertions (lines 836-838) and the final success gate/message (~lines 860-865).

**Interfaces:**
- Consumes: nothing new. `A.spawnApp('agent')` is no longer called from `sessions.js` (moved to `apps.js` in Task 2).
- Produces: no change to `window.AtelierSessions`.

Steps:

- [ ] **Step 1: Delete the ✳ button from `index.html`.** Remove this line (line 103) from the `<div class="dock">` block:
```html
          <button class="dock-btn" title="Agent">✳</button>
```
The remaining dock is exactly: Chat, Apps, Browser, Campaign, Notes, History (6 buttons).

- [ ] **Step 2: Remove the Agent dock wiring in `sessions.js`.** Replace the `wireDock` IIFE:
```js
  // ── dock wiring (see header: apps.js stripped core's dock handler) ────────
  (function wireDock() {
    const btn = Array.from(document.querySelectorAll('.dock-btn'))
      .find((b) => (b.getAttribute('title') || '').toLowerCase() === 'agent');
    if (!btn) { console.warn('[sessions] no Agent dock button found.'); return; }
    btn.addEventListener('click', () => { A.spawnApp('agent'); });
  })();
```
with a note (no handler — spawning now lives in apps.js):
```js
  // ── dock wiring ────────────────────────────────────────────────────────────
  // The ✳ Agent dock button was removed. The 💬 Chat button (wired in apps.js)
  // now spawns agent cards via A.spawnApp('agent'). No Agent-specific dock
  // handler lives in this module anymore.
```

- [ ] **Step 3: Flip the self-check Agent-button assertion.** In the `selfCheck` IIFE, replace:
```js
    const btn = Array.from(document.querySelectorAll('.dock-btn'))
      .some((b) => (b.getAttribute('title') || '').toLowerCase() === 'agent');
    console.assert(btn, '[sessions] Agent dock button missing from index.html');
```
with:
```js
    // The ✳ Agent button was removed; 💬 Chat (apps.js) now spawns agents.
    const noAgentBtn = !Array.from(document.querySelectorAll('.dock-btn'))
      .some((b) => (b.getAttribute('title') || '').toLowerCase() === 'agent');
    console.assert(noAgentBtn, '[sessions] stale ✳ Agent dock button still present');
    const chatBtn = Array.from(document.querySelectorAll('.dock-btn'))
      .some((b) => (b.getAttribute('title') || '').toLowerCase() === 'chat');
    console.assert(chatBtn, '[sessions] Chat dock button missing from index.html');
```

- [ ] **Step 4: Update the success gate + message.** In the same `selfCheck`, replace:
```js
    if (registered && btn && sweepIdle && linksOk && accessorOk && flashCssOk) {
      console.log('[sessions] self-check passed — agent app registered, '
        + 'dock wired, child sweep idle, links access guarded, '
        + 'AtelierSessions.reveal published.');
    }
```
with:
```js
    if (registered && noAgentBtn && chatBtn && sweepIdle && linksOk && accessorOk && flashCssOk) {
      console.log('[sessions] self-check passed — agent app registered, '
        + '✳ button removed (💬 Chat spawns agents), child sweep idle, '
        + 'links access guarded, AtelierSessions.reveal published.');
    }
```

- [ ] **Step 5: Document the manual test.** Append a `── MANUAL TEST ──` numbered block to the `sessions.js` header docstring (mirroring `link.js`):
```
   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up + `npm start` in desktop/. Console: expect
      "[sessions] self-check passed — … ✳ button removed (💬 Chat spawns agents) …"
      with no assertion warnings.
   2. The dock shows exactly 6 buttons: 💬 ▦ 🌐 ↺ 🗒 🕘 — no ✳.
   3. Click 💬 Chat — an agent card spawns (the old ✳ behavior).
   4. Boot with DevTools open: no console errors.
```

- [ ] **Step 6: Manually verify.** Run `npm start`, confirm the dock has 6 buttons with no ✳, 💬 Chat still spawns agent cards, the sessions self-check passes, and boot is error-free.

- [ ] **Step 7: Commit.** `refactor: remove ✳ Agent dock button and its sessions.js wiring`

Note the commit subject contains a `✳` glyph in the button name; if the repo's commit policy forbids any non-ASCII in subjects, use `refactor: remove redundant Agent dock button and its sessions.js wiring` instead.

---

## Part B: Per-chat model picker

### Task 4 — Backend: `_AgentSession.model` + `build_options(model=…)` resolution

**Files:**
- Modify `lite_server.py` — `_AgentSession.__init__` (~1541–1551); `build_options` signature (~195–197) + its `ClaudeAgentOptions(model=…)` line (~258); `_run_session_turn` lazy-client build (~1664–1668).
- Modify `tests/test_model_picker.py` — add one test after `test_build_options_runs_on_resolved_model` (~197).
- Modify `tests/test_lite_sessions.py` — add two tests after `test_sessions_never_touch_the_chat_client` (~409).

**Interfaces:**
- Produces: `_AgentSession.model: str | None = None`; `build_options(stream: bool = False, spawner_session_id: str | None = None, model: str | None = None) -> ClaudeAgentOptions` resolving `model=model or _resolved_model()`.
- Consumes: `_resolved_model()` (lite_server.py:181), `_scripted_client_factory(built=…)` (captures `options` on each built client).

- [ ] **Step 1: Write the failing build_options test (test_model_picker.py).** Append:
  ```python
  def test_build_options_honors_explicit_session_model(client):
      # an explicit per-session model beats the global resolution order
      assert lite_server.build_options(model="haiku").model == "haiku"
      client.post("/config/model", json={"model": "opus"})
      assert lite_server.build_options(model="haiku").model == "haiku"
      assert lite_server.build_options(model=None).model == "opus"  # None -> global
  ```

- [ ] **Step 2: Write the failing wiring tests (test_lite_sessions.py).** Append:
  ```python
  def test_session_model_reaches_the_sdk_client(monkeypatch, client):
      monkeypatch.setattr(lite_server, "_resolved_model", lambda: "sonnet")
      built = []
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
      )
      _inline_turns(monkeypatch)

      sid = _create(client)["id"]
      lite_server._sessions[sid].model = "haiku"  # per-session override
      client.post(f"/sessions/{sid}/message", json={"message": "hi"})
      assert built[0].options.model == "haiku"


  def test_session_without_model_uses_global(monkeypatch, client):
      monkeypatch.setattr(lite_server, "_resolved_model", lambda: "sonnet")
      built = []
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
      )
      _inline_turns(monkeypatch)

      sid = _create(client)["id"]
      client.post(f"/sessions/{sid}/message", json={"message": "hi"})
      assert built[0].options.model == "sonnet"
  ```

- [ ] **Step 3: Run the tests; confirm they FAIL.**
  - `.venv-ext/bin/python -m pytest -q tests/test_model_picker.py::test_build_options_honors_explicit_session_model -v` → `TypeError: build_options() got an unexpected keyword argument 'model'`.
  - `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py::test_session_model_reaches_the_sdk_client -v` → `AttributeError: '_AgentSession' object has no attribute 'model'`.

- [ ] **Step 4: Add the `model` field to `_AgentSession`.** In `__init__`, after `self.depth = depth`:
  ```python
          self.depth = depth
          self.model: str | None = None  # per-session model override; None -> _resolved_model()
  ```

- [ ] **Step 5: Add the `model` param to `build_options` and use it.** Change the signature:
  ```python
  def build_options(
      stream: bool = False,
      spawner_session_id: str | None = None,
      model: str | None = None,
  ) -> ClaudeAgentOptions:
  ```
  and change the `ClaudeAgentOptions` model line:
  ```python
      return ClaudeAgentOptions(
          model=model or _resolved_model(),
  ```

- [ ] **Step 6: Pass the session's model in `_run_session_turn`.** Change the lazy-client build:
  ```python
                  client = ClaudeSDKClient(
                      options=build_options(
                          spawner_session_id=sess.id if sess.depth == 0 else None,
                          model=sess.model,
                      )
                  )
  ```

- [ ] **Step 7: Run all three tests; confirm PASS.**
  - `.venv-ext/bin/python -m pytest -q tests/test_model_picker.py::test_build_options_honors_explicit_session_model tests/test_lite_sessions.py::test_session_model_reaches_the_sdk_client tests/test_lite_sessions.py::test_session_without_model_uses_global -v`.

- [ ] **Step 8: Commit.** `git commit -am "feat: per-session model override resolved in build_options"`

---

### Task 5 — Backend: `model` on `SessionCreateRequest` (allowlist-gated)

**Files:**
- Modify `lite_server.py` — `SessionCreateRequest` (~1693–1694); `create_session` (~1703–1712).
- Modify `tests/test_lite_sessions.py` — add three tests after those from Task 4.

**Interfaces:**
- Produces: `SessionCreateRequest{ name: str | None, model: str | None }`; `POST /sessions` → 400 `{"error":"unknown model"}` when `model` is set and not in `_ALLOWED_MODELS`, else sets `sess.model`.
- Consumes: `_ALLOWED_MODELS = ("sonnet","opus","haiku")` (lite_server.py:1037).

- [ ] **Step 1: Write the failing tests (test_lite_sessions.py).** Append:
  ```python
  def test_create_accepts_allowlisted_model(client):
      r = client.post("/sessions", json={"name": "R", "model": "opus"})
      assert r.status_code == 200
      assert lite_server._sessions[r.json()["id"]].model == "opus"


  def test_create_rejects_unknown_model(client):
      r = client.post("/sessions", json={"model": "gpt-4o"})
      assert r.status_code == 400
      assert r.json() == {"error": "unknown model"}
      assert lite_server._sessions == {}  # nothing created on a rejected model


  def test_create_without_model_defaults_to_none(client):
      sid = _create(client)["id"]
      assert lite_server._sessions[sid].model is None
  ```

- [ ] **Step 2: Run the tests; confirm they FAIL.**
  - `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py::test_create_rejects_unknown_model -v` → assertion fails (a junk model is currently accepted; status 200, session created).

- [ ] **Step 3: Add `model` to `SessionCreateRequest`.**
  ```python
  class SessionCreateRequest(BaseModel):
      name: str | None = None
      model: str | None = None
  ```

- [ ] **Step 4: Gate and store the model in `create_session`.** Replace the body:
  ```python
  @app.post("/sessions")
  async def create_session(req: SessionCreateRequest | None = None):
      # Gate the optional per-session model BEFORE _make_room so a junk value
      # never evicts an idle card just to be rejected.
      model = req.model if req else None
      if model is not None and model not in _ALLOWED_MODELS:
          return JSONResponse({"error": "unknown model"}, status_code=400)
      # Cap with LRU eviction (see _make_room). All running -> 409.
      if not await _make_room():
          return JSONResponse({"error": "session limit"}, status_code=409)

      name = ((req.name if req else None) or "").strip() or f"Agent {next(_session_seq)}"
      sess = _AgentSession(uuid.uuid4().hex, name)
      sess.model = model
      _sessions[sess.id] = sess
      return {"id": sess.id, "name": sess.name}
  ```

- [ ] **Step 5: Run the three tests; confirm PASS.**
  - `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py -k "create_accepts_allowlisted_model or create_rejects_unknown_model or create_without_model_defaults_to_none" -v`.

- [ ] **Step 6: Commit.** `git commit -am "feat: allowlist-gated model on SessionCreateRequest"`

---

### Task 6 — Backend: `POST /sessions/{id}/model` + `model` in `GET /sessions/{id}`

**Files:**
- Modify `lite_server.py` — `get_session` return dict (~1737–1745); new route after `get_session` (~1746).
- Modify `tests/test_lite_sessions.py` — update `test_create_list_get_shapes` detail assertion (~188–192); add five tests.

**Interfaces:**
- Produces: `GET /sessions/{id}` gains `"model": sess.model`; `POST /sessions/{id}/model {model}` → 404 `{"error":"unknown session"}` on unknown id, 400 `{"error":"unknown model"}` off-allowlist, else `{"ok": True, "model": sess.model}` (token-gated by the POST middleware).
- Consumes: `ModelRequest{model: str}` (lite_server.py:1040); `_unknown_session()`; `_ALLOWED_MODELS`; `_close_session_client(sess)`.

- [ ] **Step 1: Update the existing shape test and write the new tests (test_lite_sessions.py).** In `test_create_list_get_shapes`, change the detail assertion to include `model`:
  ```python
      detail = client.get(f"/sessions/{made['id']}").json()
      assert detail == {
          "id": made["id"], "name": "Research", "status": "idle", "messages": [],
          "parent_id": None, "depth": 0, "model": None, "browser_nav": None,
      }
  ```
  Then append:
  ```python
  def test_set_session_model_happy_path(client):
      sid = _create(client)["id"]
      r = client.post(f"/sessions/{sid}/model", json={"model": "haiku"})
      assert r.status_code == 200
      assert r.json() == {"ok": True, "model": "haiku"}
      assert lite_server._sessions[sid].model == "haiku"


  def test_set_session_model_unknown_session_404(client):
      r = client.post("/sessions/nope/model", json={"model": "haiku"})
      assert r.status_code == 404
      assert r.json() == {"error": "unknown session"}


  def test_set_session_model_rejects_unknown_model(client):
      sid = _create(client)["id"]
      r = client.post(f"/sessions/{sid}/model", json={"model": "gpt-4o"})
      assert r.status_code == 400
      assert r.json() == {"error": "unknown model"}
      assert lite_server._sessions[sid].model is None  # unchanged


  def test_get_session_surfaces_model(client):
      sid = _create(client)["id"]
      assert client.get(f"/sessions/{sid}").json()["model"] is None
      client.post(f"/sessions/{sid}/model", json={"model": "opus"})
      assert client.get(f"/sessions/{sid}").json()["model"] == "opus"


  def test_set_session_model_token_gated(monkeypatch, client):
      monkeypatch.setenv("ATELIER_TOKEN", "sekret")
      hdr = {"X-Atelier-Token": "sekret"}
      sid = client.post("/sessions", json={}, headers=hdr).json()["id"]
      assert client.post(
          f"/sessions/{sid}/model", json={"model": "opus"}
      ).status_code == 403
      r = client.post(
          f"/sessions/{sid}/model", json={"model": "opus"}, headers=hdr
      )
      assert r.status_code == 200
      assert lite_server._sessions[sid].model == "opus"
  ```

- [ ] **Step 2: Run the tests; confirm they FAIL.**
  - `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py::test_set_session_model_happy_path -v` → 404/405 (route absent).
  - `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py::test_get_session_surfaces_model -v` → `KeyError: 'model'`.

- [ ] **Step 3: Surface `model` in `GET /sessions/{id}`.** Add the key to the return dict:
  ```python
      return {
          "id": sess.id,
          "name": sess.name,
          "status": sess.status,
          "messages": list(sess.messages),
          "parent_id": sess.parent_id,
          "depth": sess.depth,
          "model": sess.model,
          "browser_nav": sess.browser_nav,
      }
  ```

- [ ] **Step 4: Add the `POST /sessions/{id}/model` route** immediately after `get_session`:
  ```python
  @app.post("/sessions/{session_id}/model")
  async def set_session_model(session_id: str, req: ModelRequest):
      """Set this session's model override (same allowlist as POST /config/model).

      Resolution at turn time is (session.model or _resolved_model()). Dropping
      the lazily-built client while idle makes the change take effect on the next
      turn; a fresh card has no client yet (no-op), and a running turn keeps its
      client (it picks the new model up on its next rebuild).
      """
      sess = _sessions.get(session_id)
      if sess is None:
          return _unknown_session()
      if req.model not in _ALLOWED_MODELS:
          return JSONResponse({"error": "unknown model"}, status_code=400)
      sess.model = req.model
      if sess.status != "running":
          await _close_session_client(sess)
      return {"ok": True, "model": sess.model}
  ```

- [ ] **Step 5: Run the updated shape test + the five new tests; confirm PASS.**
  - `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py -k "create_list_get_shapes or set_session_model or get_session_surfaces_model" -v`.

- [ ] **Step 6: Run the full backend suite for the three touched files; confirm PASS.**
  - `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py tests/test_model_picker.py -v`.

- [ ] **Step 7: Commit.** `git commit -am "feat: POST /sessions/{id}/model and model in GET /sessions/{id}"`

---

### Task 7 — Frontend: create `desktop/app/chatcontrols.js` (model-picker `mount()`)

**Files:**
- Create `desktop/app/chatcontrols.js`.
- Modify `desktop/index.html` — add the script tag after `app/sessions.js` (~143).

**Interfaces:**
- Produces: `window.Atelier.chatcontrols.mount(composerEl, ctx)` where `ctx = { scope: 'main' | 'session', sessionId?, cardEl? }`; scope `'main'` POSTs `/config/model`, scope `'session'` POSTs `/sessions/{sessionId}/model`; initial value read from `GET /config` (main) or `GET /sessions/{id}` (session, falling back to `/config` when the override is null).
- Consumes: `window.Atelier.ui.toast`; backend at `http://127.0.0.1:8765`; optional `window.atelier.token`.

- [ ] **Step 1: Write the module with its self-check.** Create `desktop/app/chatcontrols.js`:
  ```javascript
  'use strict';

  /* ===========================================================================
     Atelier feature module — chat controls   (app/chatcontrols.js)

     A shared per-composer control strip. Part B ships the MODEL PICKER half of
     mount(): a ▾ dropdown injected into any composer (the main chat card and
     each agent card) that switches which Claude model that chat runs on.

       labels -> values:  "Claude Opus 4.8" -> opus
                          "Sonnet"           -> sonnet
                          "Haiku"            -> haiku

     scope 'main'    -> POST /config/model            (the existing global route)
     scope 'session' -> POST /sessions/{sessionId}/model  (per-card override)

     On change: POST the new model; on {"ok":true} keep it + toast; on junk /
     backend-down revert the dropdown to its prior value + toast (matches the
     spec's "dropdown reverts to the prior value" error handling). The initial
     value comes from GET /config (main) or GET /sessions/{id} (session; a null
     override falls back to the global /config value).

     Part C extends this same mount() with a govern target-cursor button.

     Boundaries (per the module contract)
     ------------------------------------
     • Loads AFTER sessions.js; guards window.Atelier so a 404 stays harmless.
     • Touches ONLY window.Atelier (+ optional window.atelier.token) and its own
       injected <style>; never index.html's shell or styles.css.

     ── MANUAL TEST ────────────────────────────────────────────────────────────
     1. Backend up + `npm start` in desktop/. Console: expect "[chatcontrols] ready".
     2. The main chat composer shows a model dropdown; it reflects GET /config's
        model (sonnet by default). Pick "Haiku" — toast "Model set to Haiku";
        GET /config now reports haiku (the long-lived chat client was reset).
     3. Spawn an agent card (💬 dock). Its composer shows its own dropdown,
        defaulting to the global model. Pick "Claude Opus 4.8" — toast, and
        GET /sessions/{id} reports model "opus" independent of the global.
     4. Send a turn from that card — it runs on opus (backend build_options
        resolves session.model first); the main chat + other cards are unaffected.
     5. Stop the backend, change a dropdown — toast "Could not change the model —
        reverted." and the dropdown snaps back to its prior value.
     ========================================================================== */

  (function () {
    const A = window.Atelier;
    if (!A || !A.ui) {
      console.warn('[chatcontrols] Atelier core not available — skipping.');
      return;
    }

    const BASE = 'http://127.0.0.1:8765';
    const MODELS = [
      { label: 'Claude Opus 4.8', value: 'opus' },
      { label: 'Sonnet', value: 'sonnet' },
      { label: 'Haiku', value: 'haiku' },
    ];

    // Same fetch idiom as sessions.js: never throw on HTTP status, only on
    // network; carry the shared-secret header when main.js minted one.
    async function apiJson(path, opts) {
      const headers = { 'Content-Type': 'application/json' };
      if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
      const res = await fetch(BASE + path, Object.assign({ headers }, opts || {}));
      let data = null;
      try { data = await res.json(); } catch { /* empty/non-JSON body */ }
      return { ok: res.ok, status: res.status, data };
    }

    (function injectStyles() {
      if (document.getElementById('atl-chatcontrols-styles')) return;
      const css = `
        .atl-chatcontrols { display: flex; align-items: center; gap: 6px; }
        .atl-model-picker { font: inherit; font-size: 12px; color: var(--ink);
          background: #faf7f1; border: 1px solid var(--border); border-radius: 8px;
          padding: 3px 6px; cursor: pointer; outline: none; }
        .atl-model-picker:focus { border-color: var(--accent); }
      `;
      const style = document.createElement('style');
      style.id = 'atl-chatcontrols-styles';
      style.textContent = css;
      document.head.appendChild(style);
    })();

    function labelFor(value) {
      const m = MODELS.find((x) => x.value === value);
      return m ? m.label : value;
    }

    function endpointFor(ctx) {
      return ctx.scope === 'session'
        ? '/sessions/' + ctx.sessionId + '/model'
        : '/config/model';
    }

    function applyKnown(sel, model) {
      if (model && MODELS.some((x) => x.value === model)) { sel.value = model; }
    }

    function buildModelPicker(ctx) {
      const sel = document.createElement('select');
      sel.className = 'atl-model-picker';
      sel.title = 'Model for this chat';
      for (const m of MODELS) {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        sel.appendChild(opt);
      }
      let current = sel.value; // first option until the backend answers

      // initial value: session override else the global /config model
      (async () => {
        try {
          if (ctx.scope === 'session') {
            const r = await apiJson('/sessions/' + ctx.sessionId, { method: 'GET' });
            const override = r && r.data && r.data.model;
            if (override) { applyKnown(sel, override); current = sel.value; return; }
          }
          const g = await apiJson('/config', { method: 'GET' });
          if (g && g.data && g.data.model) { applyKnown(sel, g.data.model); current = sel.value; }
        } catch { /* backend down — keep the default option shown */ }
      })();

      sel.addEventListener('change', async () => {
        const next = sel.value;
        let r = null;
        try {
          r = await apiJson(endpointFor(ctx), {
            method: 'POST',
            body: JSON.stringify({ model: next }),
          });
        } catch { r = null; }
        if (r && r.ok && r.data && r.data.ok) {
          current = next;
          A.ui.toast('Model set to ' + labelFor(next));
        } else {
          sel.value = current; // revert to the prior value (spec error handling)
          A.ui.toast('Could not change the model — reverted.');
        }
      });
      return sel;
    }

    function mount(composerEl, ctx) {
      if (!composerEl || composerEl.querySelector('.atl-chatcontrols')) return;
      ctx = ctx || { scope: 'main' };
      const bar = document.createElement('div');
      bar.className = 'atl-chatcontrols';
      bar.appendChild(buildModelPicker(ctx));
      // Part C appends the govern target-cursor button to this same bar.
      composerEl.appendChild(bar);
    }

    A.chatcontrols = { mount };

    // ── self-check ────────────────────────────────────────────────────────────
    (function selfCheck() {
      const api = window.Atelier.chatcontrols;
      const ok = api && typeof api.mount === 'function';
      console.assert(ok, '[chatcontrols] API surface incomplete:', api);
      // mount must no-op (not throw) on a null composer — used by callers whose
      // composer/session may not exist yet.
      let threw = false;
      try { api.mount(null, { scope: 'main' }); } catch { threw = true; }
      console.assert(!threw, '[chatcontrols] mount(null) must no-op, not throw');
      if (ok && !threw) console.log('[chatcontrols] ready');
    })();
  })();
  ```

- [ ] **Step 2: Add the script tag to `index.html`** after `app/sessions.js`. Change:
  ```html
      <script defer src="app/sessions.js"></script>
      <!-- Analytics stack: vendored Chart.js, then the views overlay system,
  ```
  to:
  ```html
      <script defer src="app/sessions.js"></script>
      <!-- chatcontrols.js after sessions.js: the shared per-composer model
           picker (Part B) mounts onto the main chat composer and each agent
           card; it guards window.Atelier so a 404 stays harmless under defer. -->
      <script defer src="app/chatcontrols.js"></script>
      <!-- Analytics stack: vendored Chart.js, then the views overlay system,
  ```

- [ ] **Step 3: Manual verification (no automated harness).** With the backend up and `npm start` in `desktop/`: the console prints `[chatcontrols] ready` and no `console.assert` failures. (Full mounting is exercised by Tasks 8/9; the module alone only publishes the API.)

- [ ] **Step 4: Commit.** `git commit -am "feat: chatcontrols model picker module + index.html script tag"`

---

### Task 8 — Frontend: mount the picker on the main composer (`core.js`, scope `'main'`)

**Files:**
- Modify `desktop/app/core.js` — after the chat-card send wiring (~880).

**Interfaces:**
- Consumes: `window.Atelier.chatcontrols.mount(composerEl, { scope: 'main' })`; `inputEl` (`#input`) and its `.composer` parent.

- [ ] **Step 1: Add the deferred mount after the send wiring.** After:
  ```javascript
    sendEl.addEventListener('click', send);
  ```
  insert:
  ```javascript

    // Mount the shared model picker (chatcontrols.js) on the main chat composer.
    // chatcontrols.js is a deferred script that loads AFTER core.js, so
    // window.Atelier.chatcontrols does not exist yet at this point; deferred
    // scripts all run before DOMContentLoaded, so mounting on that event runs
    // after chatcontrols.js has published its API. Guarded: a missing module
    // (404) leaves the composer exactly as it was.
    window.addEventListener('DOMContentLoaded', () => {
      const cc = window.Atelier && window.Atelier.chatcontrols;
      const composer = inputEl && inputEl.parentElement; // the .composer div
      if (cc && typeof cc.mount === 'function' && composer) {
        cc.mount(composer, { scope: 'main' });
      }
    });
  ```

- [ ] **Step 2: Manual verification.** Boot the app: the main chat composer shows the model dropdown reflecting `GET /config` (sonnet default). Changing it toasts and persists via `POST /config/model` (verify with `curl 127.0.0.1:8765/config`). Removing `chatcontrols.js` from `index.html` and reloading leaves the composer intact (no console error).

- [ ] **Step 3: Commit.** `git commit -am "feat: mount model picker on the main chat composer"`

---

### Task 9 — Frontend: mount the picker on each agent card (`sessions.js`, scope `'session'`)

**Files:**
- Modify `desktop/app/sessions.js` — inside `createAgentCard`, the attached/fresh reveal block (~735–748).

**Interfaces:**
- Consumes: `window.Atelier.chatcontrols.mount(composer, { scope: 'session', sessionId, cardEl: card })`; closure vars `composer` (`.atl-agent-composer`), `card`, `sessionId`, `closed`, `ensureSession()`.

- [ ] **Step 1: Add a `mountChatControls` helper and call it once the session id is known.** Replace:
  ```javascript
      if (attached) {
        // the child is usually mid-turn when revealed — poll right away so the
        // existing transcript renders (renderedCount starts at 0) and the
        // thinking state appears while the spawned task runs.
        poll();
      } else {
        // create the backend session up front so the card is ready to poll; a
        // failure is fine — ensureSession() retries on the first send.
        ensureSession().catch((err) => {
          setNote(err && err.limit
            ? 'Session limit reached — close an Agent card or wait for a turn to finish, then send.'
            : 'Backend offline — the session will be created when you send.');
        });
      }
  ```
  with:
  ```javascript
      // Mount the shared per-composer model picker (chatcontrols.js, optional).
      // Deferred until the session id exists — the picker POSTs the per-session
      // model endpoint, which needs it. Guarded so a missing module no-ops.
      // Known v1 edge: if the backend evicts and send() recreates the session,
      // the picker keeps the original id in its ctx; a stale POST 404s and the
      // dropdown reverts with a toast (acceptable — recreation is rare).
      function mountChatControls() {
        const cc = window.Atelier && window.Atelier.chatcontrols;
        if (!cc || typeof cc.mount !== 'function' || !sessionId || closed) return;
        cc.mount(composer, { scope: 'session', sessionId, cardEl: card });
      }

      if (attached) {
        // the child is usually mid-turn when revealed — poll right away so the
        // existing transcript renders (renderedCount starts at 0) and the
        // thinking state appears while the spawned task runs.
        poll();
        mountChatControls(); // sessionId is known upfront for attached cards
      } else {
        // create the backend session up front so the card is ready to poll; a
        // failure is fine — ensureSession() retries on the first send.
        ensureSession().then(mountChatControls).catch((err) => {
          setNote(err && err.limit
            ? 'Session limit reached — close an Agent card or wait for a turn to finish, then send.'
            : 'Backend offline — the session will be created when you send.');
        });
      }
  ```

- [ ] **Step 2: Manual verification.** Boot the app, spawn an agent card via the 💬 dock: its composer shows a model dropdown defaulting to the global model. Set it to Haiku (toast), then send a turn — confirm the card runs on haiku (backend `GET /sessions/{id}` reports `"model":"haiku"`) while the main chat and any other card are unaffected. Spawn a second card and set a different model to confirm independence.

- [ ] **Step 3: Commit.** `git commit -am "feat: mount model picker on each agent card"`

---

## Part D: Backend governance links

**Backing spec:** `docs/superpowers/specs/2026-07-02-orchestrator-model-dock-design.md` (Part D). All new endpoints are token-gated by the existing `_reject_foreign_origins` middleware (`lite_server.py:393-403`) because they are `POST`/`DELETE`. Govern rejections are **HTTP 400** with a distinct `error` string (NOT the shared `_unknown_session()` 404 helper); `DELETE` keeps the existing 404 idiom for a missing child.

---

### Task 10 — `_MAX_DEPTH` constant + `_governs_cycle` parent-chain helper

**Files:**
- Modify `lite_server.py` (~1791, immediately after `_MAX_CHILDREN = 4`) — add `_MAX_DEPTH` and `_governs_cycle`.
- Modify `tests/test_lite_sessions.py` (append at end of file, after line 409) — add the helper unit test.

**Interfaces:**
- Produces `lite_server._MAX_DEPTH: int` (= 3) — the deepest govern chain (A→B→C→D).
- Produces `lite_server._governs_cycle(parent_id: str, child_id: str) -> bool` — walks `parent_id`'s ancestor chain via `_sessions[...].parent_id`; returns `True` if `child_id` appears (linking `child_id` under `parent_id` would close a loop). A `seen` set guards a pre-existing corrupt cycle.
- Consumes module-level `lite_server._sessions: dict[str, _AgentSession]`.

Steps:

- [ ] **Step 1: Write the failing unit test.** Append to `tests/test_lite_sessions.py`:
```python
# ── governance links: cycle helper + POST/DELETE /sessions/{id}/govern ────────

def test_governs_cycle_helper_walks_parent_chain():
    # _fresh_state (autouse) already reset _sessions to {}; build a chain A->B->C
    a = lite_server._AgentSession("a" * 32, "A")
    b = lite_server._AgentSession("b" * 32, "B", parent_id=a.id, depth=1)
    c = lite_server._AgentSession("c" * 32, "C", parent_id=b.id, depth=2)
    for s in (a, b, c):
        lite_server._sessions[s.id] = s

    # A is an ancestor of C, so governing A UNDER C would close A->B->C->A
    assert lite_server._governs_cycle(c.id, a.id) is True
    # governing C under A is a fresh downward link — no cycle
    assert lite_server._governs_cycle(a.id, c.id) is False
    # self trivially cycles (the walk starts at parent_id == child_id)
    assert lite_server._governs_cycle(a.id, a.id) is True
    # an unrelated node never cycles
    d = lite_server._AgentSession("d" * 32, "D")
    lite_server._sessions[d.id] = d
    assert lite_server._governs_cycle(a.id, d.id) is False
```

- [ ] **Step 2: Run it and confirm it FAILS.** `.venv-ext/bin/python -m pytest -q "tests/test_lite_sessions.py::test_governs_cycle_helper_walks_parent_chain" -v` — expect `AttributeError: module 'lite_server' has no attribute '_governs_cycle'`.

- [ ] **Step 3: Add the constant + helper.** In `lite_server.py`, immediately after line 1791 (`_MAX_CHILDREN = 4  # live children per parent; keeps one card from eating the cap`), insert:
```python
_MAX_DEPTH = 3  # deepest govern chain (A->B->C->D); bounds runaway delegation


def _governs_cycle(parent_id: str, child_id: str) -> bool:
    """Would setting ``child.parent_id = parent_id`` close a loop?

    Walk parent_id's ancestor chain (parent_id -> its parent -> ...); if
    child_id appears, linking child under parent would make child its own
    ancestor. The ``seen`` set also stops a pre-existing corrupt cycle from
    spinning forever.
    """
    seen: set[str] = set()
    cur: str | None = parent_id
    while cur is not None and cur not in seen:
        if cur == child_id:
            return True
        seen.add(cur)
        s = _sessions.get(cur)
        cur = s.parent_id if s is not None else None
    return False
```

- [ ] **Step 4: Run it and confirm it PASSES.** `.venv-ext/bin/python -m pytest -q "tests/test_lite_sessions.py::test_governs_cycle_helper_walks_parent_chain" -v` — expect 1 passed.

- [ ] **Step 5: Commit.** `git add lite_server.py tests/test_lite_sessions.py && git commit -m "feat: add _MAX_DEPTH and govern cycle-detection helper"`

---

### Task 11 — `POST /sessions/{id}/govern` (set `child.parent_id`/`depth`, every validation branch)

**Files:**
- Modify `lite_server.py` (~1773, immediately after the `delete_session` route ends) — add `SessionGovernRequest`, a 400 error helper, and the `govern_session` route.
- Modify `tests/test_lite_sessions.py` (append after Task 10's test) — happy-path + one test per validation branch.

**Interfaces:**
- Produces route `POST /sessions/{session_id}/govern` with body `{"child_id": <str>}` → `200 {"ok": true}` on success (sets `child.parent_id = session_id`, `child.depth = parent.depth + 1`). On rejection → `400 {"error": <str>}` where `<str>` is one of: `"unknown session"`, `"cannot govern self"`, `"would create a cycle"`, `"child limit reached"`, `"max depth reached"`.
- Consumes `lite_server._sessions`, `_governs_cycle` (Task 10), `_MAX_CHILDREN` (`lite_server.py:1791`), `_MAX_DEPTH` (Task 10), and `_AgentSession.parent_id`/`.depth` (`lite_server.py:1544-1545`).
- Single-parent invariant: re-governing a child overwrites its old `parent_id` (a move, not a second link).

Steps:

- [ ] **Step 1: Write all failing tests (happy path + every branch).** Append to `tests/test_lite_sessions.py`:
```python
def test_govern_sets_parent_id_and_depth(client):
    parent = _create(client, name="A")["id"]
    child = _create(client, name="B")["id"]

    resp = client.post(f"/sessions/{parent}/govern", json={"child_id": child})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    detail = client.get(f"/sessions/{child}").json()
    assert detail["parent_id"] == parent
    assert detail["depth"] == 1

    # nesting deepens: govern a grandchild under the depth-1 child -> depth 2
    grand = _create(client, name="C")["id"]
    assert client.post(
        f"/sessions/{child}/govern", json={"child_id": grand}
    ).json() == {"ok": True}
    assert client.get(f"/sessions/{grand}").json()["depth"] == 2


def test_govern_re_govern_moves_child_to_new_parent(client):
    p1 = _create(client, name="P1")["id"]
    p2 = _create(client, name="P2")["id"]
    child = _create(client, name="B")["id"]

    assert client.post(f"/sessions/{p1}/govern", json={"child_id": child}).status_code == 200
    assert client.post(f"/sessions/{p2}/govern", json={"child_id": child}).status_code == 200
    # single-parent invariant: the child now points at p2, not p1
    assert client.get(f"/sessions/{child}").json()["parent_id"] == p2


def test_govern_unknown_parent_is_400(client):
    child = _create(client, name="B")["id"]
    resp = client.post("/sessions/nope/govern", json={"child_id": child})
    assert resp.status_code == 400
    assert resp.json() == {"error": "unknown session"}


def test_govern_unknown_child_is_400(client):
    parent = _create(client, name="A")["id"]
    resp = client.post(f"/sessions/{parent}/govern", json={"child_id": "nope"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "unknown session"}


def test_govern_self_is_400(client):
    a = _create(client, name="A")["id"]
    resp = client.post(f"/sessions/{a}/govern", json={"child_id": a})
    assert resp.status_code == 400
    assert resp.json() == {"error": "cannot govern self"}


def test_govern_cycle_across_chain_is_400(client):
    a = _create(client, name="A")["id"]
    b = _create(client, name="B")["id"]
    c = _create(client, name="C")["id"]
    assert client.post(f"/sessions/{a}/govern", json={"child_id": b}).status_code == 200
    assert client.post(f"/sessions/{b}/govern", json={"child_id": c}).status_code == 200
    # C governing A would close A->B->C->A
    resp = client.post(f"/sessions/{c}/govern", json={"child_id": a})
    assert resp.status_code == 400
    assert resp.json() == {"error": "would create a cycle"}


def test_govern_child_limit_reached_is_400(client):
    parent = _create(client, name="P")["id"]
    kids = [
        _create(client, name=f"K{i}")["id"]
        for i in range(lite_server._MAX_CHILDREN)
    ]
    for k in kids:
        assert client.post(
            f"/sessions/{parent}/govern", json={"child_id": k}
        ).status_code == 200
    extra = _create(client, name="extra")["id"]
    resp = client.post(f"/sessions/{parent}/govern", json={"child_id": extra})
    assert resp.status_code == 400
    assert resp.json() == {"error": "child limit reached"}


def test_govern_max_depth_reached_is_400(client):
    # build a full chain L0(0)->L1(1)->...->L_MAXDEPTH(_MAX_DEPTH)
    ids = [
        _create(client, name=f"L{i}")["id"]
        for i in range(lite_server._MAX_DEPTH + 1)
    ]
    for parent, child in zip(ids, ids[1:]):
        assert client.post(
            f"/sessions/{parent}/govern", json={"child_id": child}
        ).status_code == 200
    assert client.get(f"/sessions/{ids[-1]}").json()["depth"] == lite_server._MAX_DEPTH
    # one more level would be depth _MAX_DEPTH + 1 -> rejected
    extra = _create(client, name="deep")["id"]
    resp = client.post(f"/sessions/{ids[-1]}/govern", json={"child_id": extra})
    assert resp.status_code == 400
    assert resp.json() == {"error": "max depth reached"}
```

- [ ] **Step 2: Run them and confirm they FAIL.** `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py -k govern -v` — expect the govern tests to fail (route unregistered → FastAPI returns `404 {"detail":"Not Found"}`, so the `200`/`400` and body assertions fail); the Task 10 helper test still passes.

- [ ] **Step 3: Add the request model, error helper, and route.** In `lite_server.py`, immediately after the `delete_session` route (after line 1773, the `return {"ok": True}` closing that route), insert:
```python
class SessionGovernRequest(BaseModel):
    child_id: str


def _govern_error(msg: str) -> JSONResponse:
    # Govern rejections are 400 (distinct from the /sessions 404 for a wholly
    # unknown route id) so the composer can surface the exact reason as a toast.
    return JSONResponse({"error": msg}, status_code=400)


@app.post("/sessions/{session_id}/govern")
async def govern_session(session_id: str, req: SessionGovernRequest):
    """Designate req.child_id as a governed sub-agent of session_id.

    Sets child.parent_id = session_id and child.depth = parent.depth + 1 so the
    frontend sweep re-reveals the arrow after a reload or board switch. Every
    rejection is a 400 with a distinct "error" string: unknown session, cannot
    govern self, would create a cycle, child limit reached, max depth reached.
    Single-parent invariant: re-governing a child just MOVES it (its old
    parent_id is overwritten). _MAX_DEPTH/_governs_cycle/_MAX_CHILDREN are
    defined lower in the module and resolved at call time.
    """
    parent = _sessions.get(session_id)
    if parent is None:
        return _govern_error("unknown session")
    if req.child_id == session_id:
        return _govern_error("cannot govern self")
    child = _sessions.get(req.child_id)
    if child is None:
        return _govern_error("unknown session")
    if _governs_cycle(session_id, req.child_id):
        return _govern_error("would create a cycle")
    # count current children, excluding this child so a re-govern is idempotent
    existing = sum(
        1
        for s in _sessions.values()
        if s.parent_id == session_id and s.id != req.child_id
    )
    if existing >= _MAX_CHILDREN:
        return _govern_error("child limit reached")
    if parent.depth + 1 > _MAX_DEPTH:
        return _govern_error("max depth reached")
    child.parent_id = session_id
    child.depth = parent.depth + 1
    return {"ok": True}
```

- [ ] **Step 4: Run them and confirm they PASS.** `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py -k govern -v` — expect all govern tests + the Task 10 helper test to pass. Then run the full file `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py -v` to confirm no regression.

- [ ] **Step 5: Commit.** `git add lite_server.py tests/test_lite_sessions.py && git commit -m "feat: POST /sessions/{id}/govern to link governed sub-agents"`

---

### Task 12 — `DELETE /sessions/{id}/govern/{child_id}` (clear the link)

**Files:**
- Modify `lite_server.py` (immediately after the `govern_session` route added in Task 11) — add the `ungovern_session` route.
- Modify `tests/test_lite_sessions.py` (append after Task 11's tests) — clear + idempotency + unknown-child tests.

**Interfaces:**
- Produces route `DELETE /sessions/{session_id}/govern/{child_id}` → `200 {"ok": true}` after clearing `child.parent_id = None`, `child.depth = 0`; idempotent (a second call still returns `200`). Unknown `child_id` → `404 {"error": "unknown session"}` via the existing `_unknown_session()` helper (`lite_server.py:1593`).
- Consumes `lite_server._sessions`, `_unknown_session`, `_AgentSession.parent_id`/`.depth`.
- The clear is unconditional on `child.parent_id == session_id` so a stale UI link always tears down cleanly (matches the spec's "no client-side link kept without a backend parent_id").

Steps:

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_lite_sessions.py`:
```python
def test_ungovern_clears_parent_id_and_depth(client):
    parent = _create(client, name="A")["id"]
    child = _create(client, name="B")["id"]
    assert client.post(
        f"/sessions/{parent}/govern", json={"child_id": child}
    ).status_code == 200

    resp = client.delete(f"/sessions/{parent}/govern/{child}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    detail = client.get(f"/sessions/{child}").json()
    assert detail["parent_id"] is None
    assert detail["depth"] == 0

    # idempotent: a second ungovern still succeeds
    assert client.delete(
        f"/sessions/{parent}/govern/{child}"
    ).json() == {"ok": True}


def test_ungovern_unknown_child_is_404(client):
    parent = _create(client, name="A")["id"]
    resp = client.delete(f"/sessions/{parent}/govern/nope")
    assert resp.status_code == 404
    assert resp.json() == {"error": "unknown session"}
```

- [ ] **Step 2: Run them and confirm they FAIL.** `.venv-ext/bin/python -m pytest -q "tests/test_lite_sessions.py::test_ungovern_clears_parent_id_and_depth" "tests/test_lite_sessions.py::test_ungovern_unknown_child_is_404" -v` — expect failure (route unregistered → `404 {"detail":"Not Found"}`, so the clear/`{"ok":true}` assertions and the `{"error":"unknown session"}` body assertion fail).

- [ ] **Step 3: Add the route.** In `lite_server.py`, immediately after the `govern_session` route (after its `return {"ok": True}`), insert:
```python
@app.delete("/sessions/{session_id}/govern/{child_id}")
async def ungovern_session(session_id: str, child_id: str):
    """Clear a governed child's parent_id/depth (idempotent).

    session_id is the orchestrator the arrow was drawn from, but the clear is
    unconditional so a stale link always tears down. Unknown child -> 404
    {"error": "unknown session"} (the existing /sessions idiom).
    """
    child = _sessions.get(child_id)
    if child is None:
        return _unknown_session()
    child.parent_id = None
    child.depth = 0
    return {"ok": True}
```

- [ ] **Step 4: Run them and confirm they PASS.** `.venv-ext/bin/python -m pytest -q "tests/test_lite_sessions.py::test_ungovern_clears_parent_id_and_depth" "tests/test_lite_sessions.py::test_ungovern_unknown_child_is_404" -v` — expect 2 passed. Then run the full file `.venv-ext/bin/python -m pytest -q tests/test_lite_sessions.py` to confirm the whole govern suite is green.

- [ ] **Step 5: Commit.** `git add lite_server.py tests/test_lite_sessions.py && git commit -m "feat: DELETE /sessions/{id}/govern to unlink a governed child"`

---

## Part C: Govern select-mode gesture (frontend)

Delivers the per-chat "govern mode": a target-cursor button in each session composer that highlights agent cards, click-toggles them as governed subagents (`POST`/`DELETE /sessions/{parent}/govern`), draws an orchestrator→subagent arrow via `A.arrows.link`, and shows a removable chip per governed child. New module `desktop/app/govern.js` owns state + backend + arrows + teardown; the govern half of `chatcontrols.mount()` owns the button, chip strip, highlight, and click gesture. No pytest — each frontend change ships a `console.assert` self-check plus a `── MANUAL TEST ──` block, mirroring `link.js`.

Coordination notes carried through every task below:
- **Element→id resolution:** an agent card carries no session id in the DOM today. The govern half of `chatcontrols.mount()` stamps `cardEl.dataset.atlSession = ctx.sessionId` on every session composer it mounts; `govern.js` reads that dataset to resolve parent/child elements to backend ids. The main chat (`scope:'main'`) is never stamped and never a govern target (decision 3).
- **Chip re-render:** `govern.js` emits `A.bus.emit('govern:changed', { parentEl })` on every govern/unlink/teardown; the composer subscribes and repaints that chat's chips from `Atelier.govern.childrenOf(cardEl)`. This decouples the registry (govern.js) from the UI (chatcontrols).
- **Single active chat:** entering govern mode emits `A.bus.emit('govern:mode', { on:true, cardEl })`; other mounts exit on it.
- **ponytail / known edge (mirror `link.js:60`):** the chip strip is page-session UI. Governance survives reload on the backend (`parent_id`) and the arrow is redrawn by the `sessions.js` sweep, but chips repopulate only for links made in the current page-session — `govern.js`'s registry is not rehydrated from `GET /sessions` in v1.

---

### Task 13 — Create `desktop/app/govern.js` (the govern registry + backend + arrows)

**Files:**
- Create `desktop/app/govern.js` (new, ~150 lines)

**Interfaces:**
- Consumes: `window.Atelier.bus` (`on('card:removed')`, `emit('govern:changed')`), `window.Atelier.ui.toast(msg)`, `window.Atelier.arrows.link(fromEl, toEl) -> unlink()` (optional, guarded), `window.atelier.token` (optional preload secret), backend `POST /sessions/{id}/govern {child_id}` and `DELETE /sessions/{id}/govern/{child_id}` (Part D), the `data-atl-session` dataset stamp written by chatcontrols (Task 14).
- Produces: `window.Atelier.govern = { childrenOf(parentEl) -> Element[], govern(parentEl, childEl) -> Promise<boolean>, unlink(parentEl, childEl) -> boolean, count() -> number }`; bus event `govern:changed` `{ parentEl }`.

Steps:

- [ ] **Step 1: Write `desktop/app/govern.js` in full with its self-check.** Mirror `link.js`'s module contract exactly (IIFE, core guard, module Map registry, `card:removed` teardown, self-check, `── MANUAL TEST ──` block). Complete file:

```js
'use strict';

/* ===========================================================================
   Atelier feature module — govern select-mode   (app/govern.js)

   A per-chat "govern mode": while a session card's composer target-cursor is
   armed (chatcontrols.js, Part C), clicking another agent card toggles it as a
   GOVERNED subagent of that chat. Governing POSTs the backend govern link
   (child.parent_id = parent, child.depth = parent.depth+1), draws a persistent
   orchestrator -> subagent arrow via A.arrows.link, and records the pair;
   ungoverning DELETEs the link and removes the arrow. Real delegation over the
   link is Part E; this module owns only the link's frontend lifecycle.

   How it works
   ------------
   • Element -> backend session id is read from cardEl.dataset.atlSession, a
     stamp chatcontrols.mount() writes on every session composer it mounts.
     A card with no stamp (the main chat, or a card whose composer never
     mounted) is not a valid govern endpoint — govern() toasts and bails.
   • Single-parent invariant: a child has exactly one orchestrator. The backend
     POST reassigns parent_id on re-govern; this module MOVES the child locally
     (detachChild drops the old arrow first) so the canvas matches. No stray
     DELETE on a move — the POST already reassigned the link.
   • Registry: parentEl -> Map(childEl -> { unlink }). count() sums every map.
     Every mutation emits bus 'govern:changed' {parentEl} so the composer
     (chatcontrols) repaints that chat's chip strip from childrenOf().
   • Teardown (mirrors link.js:159): bus 'card:removed' drops every link the
     removed card touches. A removed PARENT ungoverns its children (best-effort
     DELETE so each child persists UNGOVERNED per the spec) and drops arrows.
     A removed CHILD only drops its arrow here — sessions.js DELETEs the child's
     whole backend session on the same event, which clears its parent_id
     server-side, so a govern DELETE would 404 a gone session.
   • No CSS: the arrow (arrows.js) and the toast (core.js) are the whole visual
     surface owned here; the button/chip/highlight chrome lives in chatcontrols.

   API (published as window.Atelier.govern)
   ----------------------------------------
     childrenOf(parentEl) -> Element[]              governed child card elements
     govern(parentEl, childEl) -> Promise<boolean>  POST + draw arrow; false on fail
     unlink(parentEl, childEl) -> boolean           DELETE + remove arrow
     count() -> number                              live governed links

   Boundaries (per the module contract)
   ------------------------------------
   • Loads AFTER arrows.js and sessions.js (index.html order is the
     orchestrator's; this file never touches index.html or styles.css).
   • Touches ONLY window.Atelier (+ guarded window.atelier.token) and fetch.

   ponytail: like link.js, the chip strip is page-session UI and this registry
   is NOT rehydrated from GET /sessions on reload. Governance itself survives
   reload on the backend (parent_id) and the sessions.js sweep redraws the
   arrow; only the composer chips repopulate solely for links made this session.
   Rehydrating chips from the backend on mount is the upgrade.

   ── MANUAL TEST ────────────────────────────────────────────────────────────
   1. Backend up + `npm start` in desktop/. Console: expect "[govern] ready".
   2. Spawn two chats (dock 💬 twice) — Chat A and Chat B. Confirm each card's
      composer shows the ◎ govern button (chatcontrols, Task C2).
   3. In A's composer click ◎ — A's composer button goes active, every agent
      card outlines dashed (A itself solid). Click B once: POST
      /sessions/{A}/govern {child_id:B}, a terracotta arrow A -> B appears,
      toast 'Now governing Agent 2', and a "Agent 2" chip lands in A's chip
      strip. Atelier.govern.count() -> 1; Atelier.govern.childrenOf(A_cardEl)
      returns [B_cardEl].
   4. Click B again while still in govern mode (or click the chip ✕): DELETE
      /sessions/{A}/govern/{B}, the arrow and chip vanish, count() -> 0.
   5. Re-govern B from A, then arm a THIRD chat C and click B: B moves — the
      A -> B arrow is removed, a C -> B arrow is drawn, and B's chip leaves A's
      strip and appears in C's (single-parent invariant). count() stays 1.
   6. Cycle guard: arm B, click A (A already governs... use a chain). Backend
      400 'would create a cycle' surfaces a toast 'Could not govern: would
      create a cycle' and NO arrow/chip is added.
   7. Cap/depth: govern a 5th child of one parent -> toast 'Could not govern:
      child limit reached'; a 4th-deep chain -> 'Could not govern: max depth
      reached'. No arrow/chip on either.
   8. Close A's card via × -> B stays on canvas (persists, ungoverned), the
      A -> B arrow disappears, and a DELETE ungoverns B on the backend. Close a
      governed B directly -> its arrow leaves and count() drops (sessions.js
      DELETEs B's session, clearing parent_id).
   9. Backend down: click a target in govern mode -> toast 'Could not govern:
      backend unreachable' and no local link is kept. Without app/arrows.js
      loaded everything still works (link/unlink are guarded), just no arrow.
   ========================================================================== */

(function () {
  const A = window.Atelier;
  if (!A || !A.bus || !A.ui) {
    console.warn('[govern] Atelier core not available — skipping.');
    return;
  }

  const BASE = 'http://127.0.0.1:8765';

  // token-gated JSON fetch — never throws on HTTP errors, only on network
  // (same convention as sessions.js apiJson; the shared secret is present only
  // when main.js launched the backend via preload).
  async function apiJson(path, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.atelier && window.atelier.token) headers['X-Atelier-Token'] = window.atelier.token;
    const init = Object.assign({ headers }, opts || {});
    let res;
    try { res = await fetch(BASE + path, init); }
    catch { return { ok: false, status: 0, data: null }; }
    let data = null;
    try { data = await res.json(); } catch { /* empty/non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  }

  // element -> backend session id, via the dataset stamp chatcontrols writes.
  function sidOf(el) {
    return (el && el.dataset && el.dataset.atlSession) || null;
  }
  function titleOf(el) {
    const t = el && el.querySelector && el.querySelector('.card-title');
    const s = t && t.textContent ? t.textContent.trim() : '';
    return s || 'agent';
  }

  // registry: parentEl -> Map(childEl -> { unlink })
  const govs = new Map();

  function dropOne(parentEl, childEl) {
    const m = govs.get(parentEl);
    if (!m) return false;
    const entry = m.get(childEl);
    if (!entry) return false;
    try { entry.unlink(); } catch { /* arrows unlink is idempotent */ }
    m.delete(childEl);
    if (m.size === 0) govs.delete(parentEl);
    return true;
  }

  // single-parent invariant: strip childEl from whatever parent governs it now
  // (local only — the caller's backend POST already reassigned parent_id).
  function detachChild(childEl) {
    let old = null;
    govs.forEach((m, parentEl) => { if (m.has(childEl)) old = parentEl; });
    if (old) { dropOne(old, childEl); A.bus.emit('govern:changed', { parentEl: old }); }
    return old;
  }

  async function govern(parentEl, childEl) {
    const pid = sidOf(parentEl), cid = sidOf(childEl);
    if (!pid || !cid) { A.ui.toast('Cannot govern — a card has no session yet.'); return false; }
    if (parentEl === childEl || pid === cid) { A.ui.toast('A chat cannot govern itself.'); return false; }
    const r = await apiJson('/sessions/' + pid + '/govern', {
      method: 'POST',
      body: JSON.stringify({ child_id: cid }),
    });
    if (!r.ok) {
      const msg = (r.data && r.data.error) ? r.data.error : 'backend unreachable';
      A.ui.toast('Could not govern: ' + msg);
      return false;
    }
    detachChild(childEl); // move: drop the old parent's arrow first
    const arrows = A.arrows;
    const unlink = (arrows && typeof arrows.link === 'function')
      ? arrows.link(parentEl, childEl)   // orchestrator -> subagent
      : function () {};                  // arrows.js absent (plain-browser test)
    let m = govs.get(parentEl);
    if (!m) { m = new Map(); govs.set(parentEl, m); }
    m.set(childEl, { unlink });
    A.ui.toast('Now governing ' + titleOf(childEl));
    A.bus.emit('govern:changed', { parentEl });
    return true;
  }

  function unlink(parentEl, childEl) {
    const pid = sidOf(parentEl), cid = sidOf(childEl);
    const removed = dropOne(parentEl, childEl);
    if (removed && pid && cid) {
      apiJson('/sessions/' + pid + '/govern/' + cid, { method: 'DELETE' }).catch(() => {});
      A.bus.emit('govern:changed', { parentEl });
    }
    return removed;
  }

  function childrenOf(parentEl) {
    const m = govs.get(parentEl);
    return m ? Array.from(m.keys()) : [];
  }

  function count() {
    let n = 0;
    govs.forEach((m) => { n += m.size; });
    return n;
  }

  // teardown: a removed card drops every link it touches (mirrors link.js:159).
  A.bus.on('card:removed', (data) => {
    const el = data && data.el;
    if (!el) return;
    // removed as a PARENT: ungovern its children so they persist ungoverned
    if (govs.has(el)) {
      const pid = sidOf(el);
      const m = govs.get(el);
      Array.from(m.keys()).forEach((childEl) => {
        const cid = sidOf(childEl);
        if (pid && cid) apiJson('/sessions/' + pid + '/govern/' + cid, { method: 'DELETE' }).catch(() => {});
        dropOne(el, childEl);
      });
      A.bus.emit('govern:changed', { parentEl: el });
    }
    // removed as a CHILD: drop its arrow (sessions.js DELETEs the child session)
    govs.forEach((m, parentEl) => {
      if (m.has(el)) { dropOne(parentEl, el); A.bus.emit('govern:changed', { parentEl }); }
    });
  });

  // ── publish the API ────────────────────────────────────────────────────────
  A.govern = { childrenOf, govern, unlink, count };

  // ── self-check ─────────────────────────────────────────────────────────────
  (function selfCheck() {
    const api = window.Atelier.govern;
    const ok = api &&
      typeof api.childrenOf === 'function' &&
      typeof api.govern === 'function' &&
      typeof api.unlink === 'function' &&
      typeof api.count === 'function' &&
      api.count() === 0 &&
      Array.isArray(api.childrenOf(document.body)) &&
      api.childrenOf(document.body).length === 0 &&
      api.unlink(document.body, document.body) === false;
    console.assert(ok, '[govern] API surface incomplete:', api);
    if (ok) console.log('[govern] ready');
  })();
})();
```

- [ ] **Step 2: Note the manual verification (no automated harness).** Load `desktop/index.html` in a plain browser (backend optional) and confirm the console prints `[govern] ready` with no `console.assert` failures — this exercises the self-check (API shape, `count()===0`, `childrenOf(document.body)` empty array, `unlink(document.body, document.body)===false`). Full behavioral verification is the `── MANUAL TEST ──` block above, run after Task 14 wires the button (steps 2–9 need the composer button).

- [ ] **Step 3: Commit.**
  - `git add desktop/app/govern.js`
  - `git commit -m "feat: add govern.js per-chat govern-mode registry, backend link, and arrow lifecycle"`

---

### Task 14 — Add the govern button + chip strip + gesture to `chatcontrols.js`

**Files:**
- Modify `desktop/app/chatcontrols.js` (Part B's file) — add a self-contained govern section: `injectGovernStyles()`, `mountGovern(composerEl, ctx)`, a call to it from `mount()` when `ctx.scope === 'session'`, and govern steps appended to the `── MANUAL TEST ──` block. The model-dropdown half of `mount()` is Part B and is left untouched.

**Interfaces:**
- Consumes: `window.Atelier.govern` (`childrenOf`, `govern`, `unlink` — guarded, may 404 if `govern.js` absent), `window.Atelier.bus` (`on('govern:changed')`, `on('govern:mode')`, `on('shortcut:escape')`, `on('card:removed')`, `emit('govern:mode')`), the `ctx = { scope, sessionId, cardEl }` mount arg, agent card class `atl-agent-card` and `.card-title`.
- Produces: a `.atl-govern-btn` in the session composer, a `.atl-govern-chips` strip above it, `cardEl.dataset.atlSession = ctx.sessionId` stamp, bus event `govern:mode` `{ on, cardEl }`; injected `#atl-govern-styles`.

Steps:

- [ ] **Step 1: Add the govern section to `chatcontrols.js` with its own injected CSS.** Insert the following inside the module IIFE (after Part B's model-dropdown helpers, before the `A.chatcontrols = { mount }` publish), and call `mountGovern` from `mount()`. Complete code:

```js
  // ── govern select-mode (Part C) ─────────────────────────────────────────────
  // Self-contained: the button/chip/highlight chrome + the click gesture live
  // here; the govern link's backend + arrow lifecycle lives in app/govern.js
  // (window.Atelier.govern), reached lazily so a 404 on that file stays
  // harmless (the button just no-ops with a guarded call).
  function injectGovernStyles() {
    if (document.getElementById('atl-govern-styles')) return;
    const style = document.createElement('style');
    style.id = 'atl-govern-styles';
    style.textContent = `
      .atl-govern-btn { width: 32px; height: 32px; flex: 0 0 32px; border: none;
        border-radius: 9px; background: transparent; color: var(--ink-dim);
        cursor: pointer; font-size: 15px; line-height: 1; }
      .atl-govern-btn:hover { background: var(--border-soft); color: var(--ink); }
      .atl-govern-btn.active { background: var(--accent); color: #fff; }
      .atl-govern-chips { display: flex; flex-wrap: wrap; gap: 6px;
        padding: 4px 14px 0; }
      .atl-govern-chips:empty { display: none; }
      .atl-govern-chip { display: inline-flex; align-items: center; gap: 5px;
        font-size: 11px; padding: 2px 8px; border-radius: 999px;
        background: #f0e9dd; color: var(--ink); border: 1px solid var(--border-soft); }
      .atl-govern-chip-x { cursor: pointer; color: var(--ink-dim); font-weight: 700; }
      .atl-govern-chip-x:hover { color: var(--accent); }
      /* while a chat is armed, candidate agent cards highlight (source solid) */
      body.atl-governing .atl-agent-card { outline: 2px dashed var(--accent);
        outline-offset: 3px; cursor: crosshair; }
      body.atl-governing .atl-agent-card.atl-govern-source {
        outline-style: solid; cursor: default; }
    `;
    document.head.appendChild(style);
  }

  function mountGovern(composerEl, ctx) {
    injectGovernStyles();
    const A = window.Atelier;
    const cardEl = ctx.cardEl;
    // stamp the session id so govern.js resolves this card element -> id
    if (cardEl && ctx.sessionId) cardEl.dataset.atlSession = String(ctx.sessionId);

    // target-cursor toggle button (sits in the composer row, next to model ▾)
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'atl-govern-btn';
    btn.textContent = '◎';
    btn.title = 'Govern mode — click agent cards to delegate to them';
    composerEl.appendChild(btn);

    // chip strip: one chip per governed child, ✕ to ungovern. Sits just ABOVE
    // the composer row so it never fights the send button's flex line.
    const chips = document.createElement('div');
    chips.className = 'atl-govern-chips';
    if (composerEl.parentNode) composerEl.parentNode.insertBefore(chips, composerEl);

    let active = false;
    function govAPI() { return window.Atelier && window.Atelier.govern; }

    function renderChips() {
      const g = govAPI();
      chips.textContent = '';
      if (!g) return;
      g.childrenOf(cardEl).forEach((childEl) => {
        const chip = document.createElement('span');
        chip.className = 'atl-govern-chip';
        const label = document.createElement('span');
        const t = childEl.querySelector('.card-title');
        label.textContent = (t && t.textContent.trim()) || 'agent';
        const x = document.createElement('span');
        x.className = 'atl-govern-chip-x';
        x.textContent = '×';
        x.title = 'Stop governing';
        x.addEventListener('click', () => { g.unlink(cardEl, childEl); });
        chip.append(label, x);
        chips.appendChild(chip);
      });
    }

    // capture-phase mousedown: catch a click on ANOTHER agent card BEFORE
    // core's drag/bringToFront sees it, and toggle govern for that child.
    function onPick(e) {
      if (!active) return;
      const target = e.target.closest ? e.target.closest('.atl-agent-card') : null;
      if (!target || target === cardEl) return;
      if (!target.dataset.atlSession) return; // unstamped -> not a govern target
      e.preventDefault();
      e.stopPropagation();
      const g = govAPI();
      if (!g) return;
      const governed = g.childrenOf(cardEl).indexOf(target) !== -1;
      if (governed) g.unlink(cardEl, target);      // sync: chips repaint below
      else g.govern(cardEl, target);               // async: repaints on govern:changed
    }

    function enter() {
      if (active) return;
      active = true;
      btn.classList.add('active');
      document.body.classList.add('atl-governing');
      if (cardEl) cardEl.classList.add('atl-govern-source');
      document.addEventListener('mousedown', onPick, true);
      A.bus.emit('govern:mode', { on: true, cardEl }); // only one chat arms at a time
    }
    function exit() {
      if (!active) return;
      active = false;
      btn.classList.remove('active');
      document.body.classList.remove('atl-governing');
      if (cardEl) cardEl.classList.remove('atl-govern-source');
      document.removeEventListener('mousedown', onPick, true);
    }
    btn.addEventListener('click', () => { active ? exit() : enter(); });

    // Esc leaves govern mode; another chat arming exits this one; govern-link
    // changes for THIS chat repaint its chips; the card closing tears it down.
    const offEsc = A.bus.on('shortcut:escape', exit);
    const offMode = A.bus.on('govern:mode', (d) => { if (d && d.on && d.cardEl !== cardEl) exit(); });
    const offGov = A.bus.on('govern:changed', (d) => { if (d && d.parentEl === cardEl) renderChips(); });
    const offRem = A.bus.on('card:removed', (d) => {
      if (!d || d.el !== cardEl) return;
      exit();
      offEsc(); offMode(); offGov(); offRem();
    });

    renderChips();
  }
```

  And in Part B's `mount(composerEl, ctx)`, after the model-dropdown injection, add the scope gate (main chat gets no govern button per decision 3):

```js
    // Part C: session chats also get the govern target-cursor + chip strip.
    if (ctx && ctx.scope === 'session') mountGovern(composerEl, ctx);
```

- [ ] **Step 2: Extend the `── MANUAL TEST ──` block** in `chatcontrols.js` with govern steps (mirror the numbering already present from Part B):
  - Spawn two session chats; confirm each composer shows both the model `▾` and the `◎` govern button; the main chat card shows the `▾` but NO `◎`.
  - Click `◎` on Chat A → button turns accent-filled, every agent card outlines dashed, A itself solid, cursor crosshair. Click Chat B → arrow A→B, an "Agent 2" chip appears in A's strip. Re-click B or the chip `✕` → arrow + chip gone.
  - Arm A, then click `◎` on Chat C → A's button de-activates (single active chat). Arm C, click a B already governed by A → B's chip moves from A to C and the arrow re-anchors.
  - Press `Esc` while armed → govern mode exits, highlights clear. Close an armed chat's card → no dangling `atl-governing` body class remains.
  - With `govern.js` absent (rename it), the `◎` button still mounts and clicks no-op silently (guarded `govAPI()`); no console errors.

- [ ] **Step 3: Commit.**
  - `git add desktop/app/chatcontrols.js`
  - `git commit -m "feat: add govern target-cursor button, chip strip, and click gesture to chatcontrols"`

---

### Task 15 — Register `govern.js` in `desktop/index.html`

**Files:**
- Modify `desktop/index.html:149` (after the `app/link.js` tag) — add the `govern.js` script tag.

**Interfaces:**
- Consumes: nothing new. Produces: `govern.js` loaded after `arrows.js` (`:142`) and `sessions.js` (`:143`) so `A.arrows` and the agent-card class exist by the time its `card:removed` handler and `govern()` run; a 404 stays harmless under `defer` (the module guards `window.Atelier` and the button's `govAPI()` call is guarded).

Steps:

- [ ] **Step 1: Insert the govern script tag** immediately after the `app/link.js` line (`index.html:149`), so load order is `arrows.js → sessions.js → link.js → govern.js`:

```html
    <!-- govern.js after arrows + sessions: the govern-mode gesture links
         orchestrator agent cards to subagent agent cards through both
         (window.Atelier.govern; chatcontrols.js drives the button). -->
    <script defer src="app/govern.js"></script>
```

  (Part B's `app/chatcontrols.js` tag is added by that part; its lazy `window.Atelier.govern` reads make the relative order of the two tags immaterial, but keep `govern.js` before or alongside `chatcontrols.js`.)

- [ ] **Step 2: Note the manual verification.** Reload `desktop/index.html`; DevTools console shows `[govern] ready` (from Task 13's self-check) after the `[arrows] ready` / `[sessions] self-check passed` lines, confirming both dependency modules loaded first and no `defer`-order 404 broke boot.

- [ ] **Step 3: Commit.**
  - `git add desktop/index.html`
  - `git commit -m "feat: load govern.js after arrows/sessions in index.html"`

---

## Part E: Real delegation

This part adds a fourth orchestra tool, `DelegateToSubagent`, that routes a turn to an *existing* governed child (resolved by id or name among sessions whose `parent_id` equals the delegating session), and makes `build_options` attach that tool plus a govern-roster system-prompt line whenever a session has ≥1 child — at any depth, not only depth 0. The existing `SpawnAgent` depth-0 gate is left intact. Assumes Part D's `parent_id`/`depth` plumbing, the govern endpoints, and `_MAX_DEPTH = 3` already exist.

---

### Task 16 — `DelegateToSubagent` orchestra tool (route a turn to a governed child)

**Files:**
- Modify `lite_server.py` — `_orchestra_tools` (`lite_server.py:1804-1948`): add the `_delegate_agent` `@tool` and append it to the returned list at `:1948`. Confirm `_MAX_DEPTH = 3` sits next to `_MAX_CHILDREN` (`lite_server.py:1791`); add it there if Part D has not.
- Modify `tests/test_subagents.py` — the `_handlers` helper (`tests/test_subagents.py:96-100`); add a new `_delegate_handler` helper and a `── DelegateToSubagent ──` test section.

**Interfaces:**
- Produces: `DelegateToSubagent(subagent: str, task: str)` as the 4th element of `_orchestra_tools(parent_id) -> list` (an `SdkMcpTool` whose `.handler` is an async `(args: dict) -> {"content":[{"type":"text","text":str}]}`). Resolves an existing child (`parent_id == <closed-over parent_id>`) by exact id then exact name; appends the task as the child's user message, awaits `_run_session_turn(child, task)`, returns the child's last assistant reply. Enforces `_MAX_DEPTH` (blocks when the delegating session is already at the cap) and reuses the `_MAX_CHILDREN` invariant (it only targets already-governed children, never creating new ones).
- Consumes: `_sessions`, `_AgentSession`, `_append_session_message`, `_touch_session`, `_run_session_turn`, `_tool_text`, `_MAX_DEPTH` (all in `lite_server.py`).

Steps:

- [ ] **Step 1: Write the failing tests.** In `tests/test_subagents.py`, change the `_handlers` helper to tolerate the extra tool, add a `_delegate_handler` helper, and add the delegation section. First edit the helper:

  ```python
  def _handlers(parent_id):
      """The (SpawnAgent, CheckAgent, NavigateBrowser) handler coroutines bound
      to parent_id. Tolerates extra orchestra tools (DelegateToSubagent)."""
      spawn, check, nav, *_ = lite_server._orchestra_tools(parent_id)
      return spawn.handler, check.handler, nav.handler


  def _delegate_handler(parent_id):
      """The DelegateToSubagent handler coroutine (the 4th orchestra tool)."""
      return lite_server._orchestra_tools(parent_id)[3].handler
  ```

  Then append this section at the end of the file (after the `NavigateBrowser` tests):

  ```python
  # ── DelegateToSubagent ───────────────────────────────────────────────────────

  _NO_MATCH = (
      'No governed sub-agent matches "{ref}". Govern a card first, or use'
      " its exact id or name."
  )


  def _govern(parent, name, sid=None, depth=None):
      """Register an already-governed child (parent_id == parent.id)."""
      child = lite_server._AgentSession(
          sid or uuid_like(name),
          name,
          parent_id=parent.id,
          depth=(parent.depth + 1) if depth is None else depth,
      )
      lite_server._sessions[child.id] = child
      return child


  def uuid_like(seed):
      # a 32-hex id derived from the name, unique per test child
      import hashlib
      return hashlib.md5(seed.encode()).hexdigest()


  def test_delegate_runs_a_turn_on_the_governed_child_and_returns_its_reply(
      monkeypatch,
  ):
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory()
      )
      parent = _register_parent()
      child = _govern(parent, "Scout")
      delegate = _delegate_handler(parent.id)

      reply = _text(
          _call(delegate, {"subagent": child.id, "task": "summarize the vault"})
      )
      assert reply == 'Sub-agent "Scout" replied: scripted reply'
      assert child.status == "idle"
      assert [(m["role"], m["text"]) for m in child.messages] == [
          ("user", "summarize the vault"),
          ("assistant", "scripted reply"),
      ]


  def test_delegate_resolves_child_by_name(monkeypatch):
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory()
      )
      parent = _register_parent()
      _govern(parent, "Scout")
      delegate = _delegate_handler(parent.id)
      assert _text(_call(delegate, {"subagent": "Scout", "task": "t"})) == (
          'Sub-agent "Scout" replied: scripted reply'
      )


  def test_delegate_rejects_a_non_governed_target(monkeypatch):
      # containment: a foreign card / sibling's child / junk are all "no match",
      # and none of them is ever run.
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory()
      )
      parent = _register_parent()
      other = lite_server._AgentSession("othercard0", "Other")
      lite_server._sessions[other.id] = other
      delegate = _delegate_handler(parent.id)
      for ref in (other.id, "Other", "nope"):
          assert _text(_call(delegate, {"subagent": ref, "task": "t"})) == (
              _NO_MATCH.format(ref=ref)
          )
      assert other.messages == []  # the foreign session never ran


  def test_delegate_by_name_is_ambiguous_when_two_children_share_a_name(
      monkeypatch,
  ):
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory()
      )
      parent = _register_parent()
      _govern(parent, "Twin", sid="twin000000000000000000000000000a")
      _govern(parent, "Twin", sid="twin000000000000000000000000000b")
      delegate = _delegate_handler(parent.id)
      assert _text(_call(delegate, {"subagent": "Twin", "task": "t"})) == (
          'Multiple governed sub-agents are named "Twin"; delegate by id instead.'
      )


  def test_delegate_rejects_a_busy_child(monkeypatch):
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory()
      )
      parent = _register_parent()
      child = _govern(parent, "Scout")
      child.status = "running"
      delegate = _delegate_handler(parent.id)
      assert _text(_call(delegate, {"subagent": "Scout", "task": "t"})) == (
          'Sub-agent "Scout" is busy with another turn; try again shortly.'
      )
      # nothing appended: the turn was refused before it ran
      assert child.messages == []


  def test_delegate_with_parent_gone():
      delegate = _delegate_handler("deadbeef00000000deadbeef00000000")
      assert _text(_call(delegate, {"subagent": "x", "task": "t"})) == (
          "Your session is gone; cannot delegate."
      )


  def test_delegate_blocked_at_max_depth():
      # a session already at the depth cap cannot delegate further down the
      # chain (bounds A->B->C->... recursion); the child is never run.
      parent = lite_server._AgentSession(
          "deepparent00000000000000000000aa",
          "Deep",
          parent_id="p" * 32,
          depth=lite_server._MAX_DEPTH,
      )
      parent.status = "running"
      lite_server._sessions[parent.id] = parent
      child = _govern(parent, "Child", depth=lite_server._MAX_DEPTH + 1)
      delegate = _delegate_handler(parent.id)
      assert _text(_call(delegate, {"subagent": child.id, "task": "t"})) == (
          f"Max delegation depth ({lite_server._MAX_DEPTH}) reached — cannot"
          " delegate further down this chain."
      )
      assert child.messages == []
  ```

- [ ] **Step 2: Run the tests; confirm they FAIL.** Run:

  `.venv-ext/bin/python -m pytest -q tests/test_subagents.py::test_delegate_runs_a_turn_on_the_governed_child_and_returns_its_reply -v`

  Expected failure: `IndexError: list index out of range` (raised inside `_delegate_handler` because `_orchestra_tools` still returns only 3 tools, so `[3]` is out of range). The other new tests fail the same way. Confirm the existing `SpawnAgent`/`CheckAgent`/`NavigateBrowser` tests still PASS (the `*_` change is forward-compatible):

  `.venv-ext/bin/python -m pytest -q tests/test_subagents.py -v`

- [ ] **Step 3: Confirm `_MAX_DEPTH`, then implement the tool.** In `lite_server.py`, verify `_MAX_DEPTH = 3` exists next to `_MAX_CHILDREN` at `:1791`; if Part D did not add it, add it:

  ```python
  _MAX_CHILDREN = 4  # live children per parent; keeps one card from eating the cap
  _MAX_DEPTH = 3  # deepest orchestration chain (A->B->C->D); bounds delegation recursion
  ```

  Then, inside `_orchestra_tools`, insert the `_delegate_agent` tool immediately before the `return [_spawn_agent, _check_agent, _navigate_browser]` line (`:1948`):

  ```python
      @tool(
          "DelegateToSubagent",
          "Delegate a subtask to one of the sub-agent cards you already govern"
          " (an existing card on the canvas), identified by its session id or"
          " its display name. The sub-agent runs the task in its own session and"
          " its reply is returned to you. Use this to hand work to a specific"
          " governed card rather than spawning a brand-new one with SpawnAgent.",
          {
              "type": "object",
              "properties": {
                  "subagent": {
                      "type": "string",
                      "description": "The governed sub-agent to delegate to, by"
                      " its session id or its exact display name.",
                  },
                  "task": {
                      "type": "string",
                      "description": "The subtask for the sub-agent to work on,"
                      " written as a complete standalone instruction.",
                  },
              },
              "required": ["subagent", "task"],
          },
      )
      async def _delegate_agent(args):
          parent = _sessions.get(parent_id)
          if parent is None:
              # The delegator was deleted/evicted mid-turn.
              return _tool_text("Your session is gone; cannot delegate.")
          if parent.depth >= _MAX_DEPTH:
              # Bound the chain (A->B->C->...): a session at the cap cannot push
              # work one level deeper. Normally unreachable because govern caps
              # child depth at _MAX_DEPTH, so a capped session has no children —
              # kept as a defensive runtime gate.
              return _tool_text(
                  f"Max delegation depth ({_MAX_DEPTH}) reached — cannot"
                  " delegate further down this chain."
              )
          ref = (args.get("subagent") or "").strip()
          children = [
              s for s in _sessions.values() if s.parent_id == parent_id
          ]
          # Resolve by exact id first, then by exact name (containment: only this
          # session's OWN governed children are reachable — never a foreign card).
          child = next((s for s in children if s.id == ref), None)
          if child is None:
              named = [s for s in children if s.name == ref]
              if len(named) > 1:
                  return _tool_text(
                      f'Multiple governed sub-agents are named "{ref}";'
                      " delegate by id instead."
                  )
              child = named[0] if named else None
          if child is None:
              return _tool_text(
                  f'No governed sub-agent matches "{ref}". Govern a card first,'
                  " or use its exact id or name."
              )
          if child.status == "running":
              return _tool_text(
                  f'Sub-agent "{child.name}" is busy with another turn; try'
                  " again shortly."
              )
          # Run the turn on the EXISTING child inline (synchronous delegation):
          # its card streams the delegated task + reply through its normal poll,
          # and we hand the reply straight back to the delegating model. Mirror
          # _start_turn's pre-run bookkeeping (append user msg, mark running,
          # touch LRU) since _run_session_turn assumes the caller did it.
          _append_session_message(child, "user", args["task"])
          child.status = "running"
          _touch_session(child)
          await _run_session_turn(child, args["task"])
          last_reply = next(
              (
                  m["text"]
                  for m in reversed(child.messages)
                  if m["role"] == "assistant"
              ),
              "(no reply)",
          )
          return _tool_text(
              f'Sub-agent "{child.name}" replied: {last_reply}'
          )
  ```

  Update the return line at `:1948`:

  ```python
      return [_spawn_agent, _check_agent, _navigate_browser, _delegate_agent]
  ```

- [ ] **Step 4: Run the tests; confirm they PASS.** Run the whole file so the delegation tests, the untouched `SpawnAgent`/`CheckAgent`/`NavigateBrowser` tests, and the `GET /tools` registry test (which now enumerates 4 orchestra tools) all go green:

  `.venv-ext/bin/python -m pytest -q tests/test_subagents.py -v`

- [ ] **Step 5: Commit.** `git add lite_server.py tests/test_subagents.py && git commit -m "feat: add DelegateToSubagent orchestra tool for routing turns to governed children"`

---

### Task 17 — attach `DelegateToSubagent` + a govern-roster prompt line whenever a session has children

**Files:**
- Modify `lite_server.py` — `ATELIER_INSTRUCTIONS` (`lite_server.py:82-93`); `build_options` signature + body + return (`lite_server.py:195-270`); the `build_options(...)` call inside `_run_session_turn` (`lite_server.py:1660-1668`).
- Modify `tests/test_subagents.py` — add attach-condition tests to the `── the structural depth cap ──` section (near `tests/test_subagents.py:433-481`).

**Interfaces:**
- Produces: `build_options(stream=False, spawner_session_id=None, delegator_session_id=None) -> ClaudeAgentOptions`. When `delegator_session_id` names a session with ≥1 child, the result gains the `orchestra` MCP server (if not already present), `"mcp__orchestra__DelegateToSubagent"` in `allowed_tools`, and a `system_prompt` line naming each governed child as `"<name>" (<id>)`. The depth-0 `spawner_session_id` path (adding `SpawnAgent`/`CheckAgent`/`NavigateBrowser`) is unchanged.
- Consumes: `_sessions` (children lookup), `_build_orchestra_server`, `ATELIER_INSTRUCTIONS`, `_resolved_model` (unchanged). `_run_session_turn` now passes `delegator_session_id=sess.id` for every session (any depth) while still passing `spawner_session_id` only for depth 0.

Steps:

- [ ] **Step 1: Write the failing tests.** In `tests/test_subagents.py`, add these to the depth-cap section:

  ```python
  def test_build_options_attaches_delegate_when_session_has_children():
      # a depth-1 governed orchestrator (B in A->B->C) with one child gains
      # DelegateToSubagent but NOT SpawnAgent (the depth-0 gate is unchanged).
      parent = lite_server._AgentSession(
          "b" * 32, "B", parent_id="a" * 32, depth=1
      )
      lite_server._sessions[parent.id] = parent
      child = lite_server._AgentSession(
          "c" * 32, "C", parent_id=parent.id, depth=2
      )
      lite_server._sessions[child.id] = child

      opts = lite_server.build_options(delegator_session_id=parent.id)
      assert "orchestra" in opts.mcp_servers
      assert "mcp__orchestra__DelegateToSubagent" in opts.allowed_tools
      assert "mcp__orchestra__SpawnAgent" not in opts.allowed_tools
      # the governed child is named in the system prompt (roster line)
      assert child.id in opts.system_prompt
      assert '"C"' in opts.system_prompt


  def test_build_options_no_delegate_when_session_has_no_children():
      lonely = lite_server._AgentSession("d" * 32, "Lonely", depth=0)
      lite_server._sessions[lonely.id] = lonely
      opts = lite_server.build_options(
          spawner_session_id=lonely.id, delegator_session_id=lonely.id
      )
      assert "mcp__orchestra__DelegateToSubagent" not in opts.allowed_tools
      # a depth-0 spawner still gets the spawn tools even with no children
      assert "mcp__orchestra__SpawnAgent" in opts.allowed_tools
      assert opts.system_prompt == lite_server.ATELIER_INSTRUCTIONS


  def test_build_options_depth0_with_children_gets_both_spawn_and_delegate():
      parent = lite_server._AgentSession("p" * 32, "P", depth=0)
      lite_server._sessions[parent.id] = parent
      child = lite_server._AgentSession(
          "q" * 32, "Q", parent_id=parent.id, depth=1
      )
      lite_server._sessions[child.id] = child
      opts = lite_server.build_options(
          spawner_session_id=parent.id, delegator_session_id=parent.id
      )
      assert "mcp__orchestra__SpawnAgent" in opts.allowed_tools
      assert "mcp__orchestra__DelegateToSubagent" in opts.allowed_tools
      assert '"Q"' in opts.system_prompt


  def test_turn_on_orchestrator_with_child_builds_delegate_tool(
      monkeypatch, client
  ):
      # end-to-end: _run_session_turn passes delegator_session_id, so a depth-0
      # card that governs a child builds its client WITH DelegateToSubagent and
      # the roster line.
      built = []
      monkeypatch.setattr(
          lite_server, "ClaudeSDKClient", _scripted_client_factory(built=built)
      )
      _inline_turns(monkeypatch)

      sid = client.post("/sessions", json={"name": "A"}).json()["id"]
      child = lite_server._AgentSession(
          "c" * 32, "B", parent_id=sid, depth=1
      )
      lite_server._sessions[child.id] = child

      assert client.post(
          f"/sessions/{sid}/message", json={"message": "orchestrate"}
      ).status_code == 202
      assert (
          "mcp__orchestra__DelegateToSubagent" in built[0].options.allowed_tools
      )
      assert child.id in built[0].options.system_prompt
  ```

- [ ] **Step 2: Run the tests; confirm they FAIL.** Run:

  `.venv-ext/bin/python -m pytest -q tests/test_subagents.py::test_build_options_attaches_delegate_when_session_has_children -v`

  Expected failure: `TypeError: build_options() got an unexpected keyword argument 'delegator_session_id'` for the three `build_options` tests, and an `AssertionError` (delegate tool absent from `allowed_tools`) for `test_turn_on_orchestrator_with_child_builds_delegate_tool`. Confirm the pre-existing `test_build_options_without_spawner_has_no_orchestra`, `test_build_options_with_spawner_gains_orchestra`, and `test_depth0_turn_gets_orchestra_and_depth1_turn_does_not` still PASS unchanged.

- [ ] **Step 3: Implement the attach condition.** In `lite_server.py`, first append a delegation sentence to `ATELIER_INSTRUCTIONS` (`:93`):

  ```python
  When SpawnAgent/CheckAgent are available you can delegate a subtask to a parallel sub-agent and collect its result later; sub-agents run as their own isolated sessions. When DelegateToSubagent is available you govern one or more existing sub-agent cards; call it with a governed card's id or name to hand it a subtask and get its reply back inline."""
  ```

  Change the `build_options` signature (`:195-197`):

  ```python
  def build_options(
      stream: bool = False,
      spawner_session_id: str | None = None,
      delegator_session_id: str | None = None,
  ) -> ClaudeAgentOptions:
  ```

  Replace the mcp/allowlist block (`:247-255`) with:

  ```python
      mcp_servers = {"atelier": ATELIER_SERVER}
      allowed_tools = list(ATELIER_ALLOWED_TOOLS)
      system_prompt = ATELIER_INSTRUCTIONS

      # A depth-0 spawner gets the full orchestra (Spawn/Check/Nav). SEPARATELY,
      # ANY session that already governs >=1 child (a back-reference by
      # parent_id) gains DelegateToSubagent + a system-prompt line naming those
      # children — so a depth-1+ orchestrator (chained A->B->C) can delegate to
      # its existing cards without being able to spawn new ones. Both bind their
      # orchestra tools to the SAME session id, so one server serves both.
      children = (
          [s for s in _sessions.values() if s.parent_id == delegator_session_id]
          if delegator_session_id is not None
          else []
      )
      orchestra_id = spawner_session_id or (
          delegator_session_id if children else None
      )
      if orchestra_id is not None:
          mcp_servers["orchestra"] = _build_orchestra_server(orchestra_id)
          if spawner_session_id is not None:
              allowed_tools += [
                  "mcp__orchestra__SpawnAgent",
                  "mcp__orchestra__CheckAgent",
                  "mcp__orchestra__NavigateBrowser",
              ]
          if children:
              allowed_tools.append("mcp__orchestra__DelegateToSubagent")
              roster = ", ".join(f'"{c.name}" ({c.id})' for c in children)
              system_prompt = (
                  ATELIER_INSTRUCTIONS
                  + "\n\nYou govern these sub-agent cards: "
                  + roster
                  + ". Use DelegateToSubagent(subagent, task) to hand a subtask"
                  " to one of them by id or name; the sub-agent runs it and its"
                  " reply is returned to you."
              )
  ```

  Update the `ClaudeAgentOptions(...)` return so it uses the computed prompt (`:259`):

  ```python
          system_prompt=system_prompt,
  ```

  Finally, in `_run_session_turn`, pass `delegator_session_id` for every session while keeping the `spawner_session_id` depth-0 gate (`:1664-1668`):

  ```python
                  client = ClaudeSDKClient(
                      options=build_options(
                          spawner_session_id=sess.id if sess.depth == 0 else None,
                          delegator_session_id=sess.id,
                      )
                  )
  ```

- [ ] **Step 4: Run the tests; confirm they PASS.** Run the full delegation-relevant suites so the new attach tests, the unchanged depth-cap tests, and the model-picker `build_options` contract all stay green:

  `.venv-ext/bin/python -m pytest -q tests/test_subagents.py tests/test_model_picker.py -v`

- [ ] **Step 5: Commit.** `git add lite_server.py tests/test_subagents.py && git commit -m "feat: attach DelegateToSubagent and govern roster whenever a session has children"`