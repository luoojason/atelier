"""Lite subscription backend for Atelier.

A single-file FastAPI app that serves ONE "Atelier" agent on the user's Claude
Max subscription via the official claude-agent-sdk (native tool_use — the CLI
runs on the Max OAuth login with zero API keys). It carries only the LIGHT
tools that import cleanly without the heavy media deps (weasyprint / playwright
/ moviepy / jupyter / google-genai) and deliberately does NOT import
swarm.create_agency or any of the heavy specialist agents.

The earlier fenced-JSON bridge (claude_subscription_model, ~60% reliable — the
model would intermittently emit a NATIVE tool call the bridge rejected) is gone
from this path; the SDK speaks native tool_use directly. claude_subscription_model
and agency_swarm stay intact for the heavy swarm in server.py.

Isolation is UNCONDITIONAL for the app agent now: options.env pins a private
CLAUDE_CONFIG_DIR + empty CLAUDE_SECURESTORAGE_CONFIG_DIR (keeps Max OAuth on
the default Keychain item) and strips inherited API keys, and setting_sources=[]
is the safe-mode equivalent (no CLAUDE.md / hooks / plugins / skills / auto-
memory). No DEFAULT_MODEL / claude_subscription_model wiring is needed.

Run:
    PORT=8765 \
        /Users/jasonluo08/Desktop/openswarm/.venv-ext/bin/python lite_server.py
"""

import asyncio
import contextlib
import datetime
import itertools
import json
import os
import re
import secrets
import uuid
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    StreamEvent,
    TextBlock,
)

# --- LIGHT tools (all verified to import under .venv-ext) ---
from shared_tools import (
    VaultSearch,
    VaultRead,
    VaultWrite,
    RememberFact,
    RecallMemory,
    CaptureBrief,
    ReadBrief,
)
from shared_tools.sdk_tools import build_atelier_server
from campaign_agent.tools.StartCampaign import StartCampaign
from campaign_agent.tools.RecordDeliverable import RecordDeliverable
from campaign_agent.tools.CampaignStatus import CampaignStatus

# Pure stdlib scheduler helpers backing the read-only dashboard endpoints.
from scheduler import jobs_core, run_store
from scheduler import notify as swarm_notify

# Pure stdlib Claude Code transcript readers backing /config + /cc/*.
import cc_usage

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field


ATELIER_INSTRUCTIONS = """You are Atelier, a studio assistant running on the user's own Claude subscription.

Your job is to help run a creative studio out of an Obsidian knowledge vault:
- Search and read the vault (VaultSearch, VaultRead) to pull existing context, decisions, and status before acting.
- Write notes back to the vault (VaultWrite) when you produce something worth keeping.
- Remember and recall durable facts across turns (RememberFact, RecallMemory).
- Capture and read structured Briefs (CaptureBrief, ReadBrief) so intent is written down before work starts.
- Plan and track gated campaigns (StartCampaign, RecordDeliverable, CampaignStatus): decompose a goal into deliverables, and only treat a deliverable as publishable once it has a shippable verdict.

Be concise. When you take an action with a tool, say plainly what you did and cite the note path, brief, or campaign id involved. Do not claim to have published or shipped anything that has not passed its gate."""

LIGHT_TOOLS = [
    VaultSearch,
    VaultRead,
    VaultWrite,
    RememberFact,
    RecallMemory,
    CaptureBrief,
    ReadBrief,
    StartCampaign,
    RecordDeliverable,
    CampaignStatus,
]

# One in-process MCP server ("atelier") wrapping all 10 BaseTool subclasses as
# native SDK tools, plus the mcp__atelier__<ClassName> allowlist for the agent.
ATELIER_SERVER, ATELIER_ALLOWED_TOOLS = build_atelier_server(LIGHT_TOOLS)


def _resolved_model() -> str:
    """The SDK model string: CLAUDE_CLI_MODEL env else 'sonnet'."""
    return os.getenv("CLAUDE_CLI_MODEL") or "sonnet"


def build_options(stream: bool = False) -> ClaudeAgentOptions:
    """The single builder for BOTH the /chat client and every compat request.

    Resolves model + isolation env + the atelier MCP server + allowed_tools +
    setting_sources in ONE place so the chat session and the scheduler's fresh
    per-request sessions can never drift.

    ``stream=True`` enables include_partial_messages so /chat/stream can emit
    token deltas. Harmless for the non-streaming drain (it ignores StreamEvent).

    Isolation (unconditional for the app agent): a private CLAUDE_CONFIG_DIR
    (respect an existing override, else ~/.atelier/claude-home, created if
    missing), an empty CLAUDE_SECURESTORAGE_CONFIG_DIR (keeps Max OAuth on the
    default Keychain item), stripped inherited API keys, and setting_sources=[]
    (no CLAUDE.md / hooks / plugins / skills / auto-memory).
    """
    config_dir = os.environ.get(
        "CLAUDE_CONFIG_DIR", os.path.expanduser("~/.atelier/claude-home")
    )
    os.makedirs(config_dir, exist_ok=True)

    env = {k: v for k, v in os.environ.items()}
    # Strip any inherited API/auth keys so the run stays on the Max OAuth login.
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    env["CLAUDE_CONFIG_DIR"] = config_dir
    env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = ""

    return ClaudeAgentOptions(
        model=_resolved_model(),
        system_prompt=ATELIER_INSTRUCTIONS,
        mcp_servers={"atelier": ATELIER_SERVER},
        allowed_tools=ATELIER_ALLOWED_TOOLS,
        setting_sources=[],
        env=env,
        # Ceiling learned live: the weekly project-rollup job (VaultSearch +
        # reading dozens of Projects/ pages + VaultWrite) blew through 12 with
        # "Reached maximum number of turns". 40 fits the heaviest real job;
        # env knob for tuning without a rebuild.
        max_turns=int(os.getenv("ATELIER_MAX_TURNS", "40")),
        include_partial_messages=stream,
    )


async def _collect_response(client: ClaudeSDKClient) -> dict:
    """Drain one turn: concatenate assistant TextBlocks, honor a failed result.

    Returns the {"response"} (+"error": true) HTTP shape. A failed/aborted
    ResultMessage (is_error) surfaces as the error shape even if some text came
    through, matching the "never claim success on failure" contract.
    """
    texts: list[str] = []
    async for msg in client.receive_response():
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    texts.append(block.text)
        elif isinstance(msg, ResultMessage):
            if msg.is_error:
                detail = msg.result or (
                    "; ".join(msg.errors) if msg.errors else "run failed"
                )
                return {
                    "response": (
                        f"Atelier hit an error and could not finish that turn: {detail}"
                    ),
                    "error": True,
                }
    return {"response": "".join(texts).strip()}


# One long-lived chat client, lazily connected on first /chat use and guarded by
# a lock so concurrent /chat calls serialize onto the single conversation. The
# scheduler compat route uses its OWN fresh client (never this one).
_chat_client: ClaudeSDKClient | None = None
_chat_lock = asyncio.Lock()


async def _get_chat_client() -> ClaudeSDKClient:
    global _chat_client
    if _chat_client is None:
        # stream=True so /chat/stream gets token deltas; the non-streaming /chat
        # drain ignores the extra StreamEvents, so one client serves both.
        client = ClaudeSDKClient(options=build_options(stream=True))
        await client.connect()
        _chat_client = client
    return _chat_client


async def _reset_chat_client() -> None:
    """Drop the long-lived chat client so the next /chat reconnects a fresh one.

    Called after a mid-turn SDK failure: the underlying claude CLI subprocess or
    transport may be dead, and reusing the same client would re-raise on every
    subsequent turn (wedging the session until the app restarts). Guarded by
    _chat_lock so we never null the client out from under a concurrent caller.
    """
    global _chat_client
    async with _chat_lock:
        if _chat_client is not None:
            try:
                await _chat_client.disconnect()
            except Exception:  # noqa: BLE001 - already broken; best-effort teardown
                pass
            finally:
                _chat_client = None


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI):
    # Nothing to warm up; the chat client connects lazily on first /chat.
    yield
    global _chat_client
    if _chat_client is not None:
        try:
            await _chat_client.disconnect()
        finally:
            _chat_client = None
    # Tear down every multi-card agent session (see the sessions section below).
    for sess in list(_sessions.values()):
        await _close_session_client(sess)
    _sessions.clear()


app = FastAPI(title="Atelier Lite", lifespan=_lifespan)

# Local-only server, but allow_origins=["*"] would let ANY web page — in the
# user's regular browser, or loaded inside the app's own browser card — read
# /runs//jobs//metrics//notifications and drive POST /chat (drive-by prompt
# injection). Legitimate callers are: the Electron renderer / a file:// test
# page (Origin "null" or "file://"), local dev pages, and no-Origin clients
# (curl, main.js's Node fetch, TestClient). Everything else is rejected
# server-side too, since CORS alone only hides the response.
#
# Origin gating alone is not enough for the MUTATING routes: any internet page
# can mint Origin "null" (<iframe sandbox="allow-scripts" srcdoc=...>) and
# "null" must stay allowed because the Electron file:// renderer sends it. So
# writes additionally require a shared-secret header: main.js mints
# ATELIER_TOKEN fresh per launch and threads it to the renderer via preload
# and to both sidecars via spawn env. Token unset (dev uvicorn, plain-browser
# testing, TestClient) -> the token gate is off and origin gating is the wall.
#
# ACCEPTED RISK (security review 2026-07): because "null" is CORS-allowed and
# read-only GETs are deliberately not token-gated (frozen contract), a hostile
# page in a browser without strict Private Network Access enforcement
# (Firefox/Safari today; Chrome blocks via PNA preflight) can READ /config and
# /cc/* cross-origin via a sandboxed iframe: monthly spend, per-session cost,
# session ids, and munged project directory names. If that ever becomes
# unacceptable, token-gate /cc/*+/config when ATELIER_TOKEN is set (the
# renderer already has the token via preload), or stop returning project
# directory names from /cc/usage.
_ORIGIN_RE = r"^(null|file://|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"
_origin_ok = re.compile(_ORIGIN_RE).match
_MUTATING_METHODS = ("POST", "PUT", "PATCH", "DELETE")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_ORIGIN_RE,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _reject_foreign_origins(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin is not None and not _origin_ok(origin):
        return JSONResponse({"detail": "origin not allowed"}, status_code=403)
    token = os.getenv("ATELIER_TOKEN", "")  # call-time read so tests can tune it
    if token and request.method in _MUTATING_METHODS:
        supplied = request.headers.get("x-atelier-token", "")
        if not secrets.compare_digest(supplied, token):
            return JSONResponse({"detail": "missing or bad token"}, status_code=403)
    return await call_next(request)


class ChatRequest(BaseModel):
    message: str


class AgencyResponseRequest(BaseModel):
    """Body shape of the agency server's get_response route (scheduler compat)."""

    message: str
    recipient_agent: str | None = None


@app.get("/health")
async def health():
    return {
        "ok": True,
        "model": _resolved_model(),
        "subscription": True,
    }


# --- Read-only dashboard endpoints (fixed shapes; never 500 on missing files) ---
#
# All file reads resolve their paths from env at CALL time (SWARM_RUNS_JSONL /
# SWARM_NOTIFICATIONS / SWARM_MEMORY_PATH / SWARM_JOBS_FILE) and every reader
# degrades to an empty shape when the file is missing or malformed.
# ponytail: sync file reads inside async handlers — the ledgers are tiny local
# JSONL files; move to run_in_threadpool if they ever grow.

_SCHED_DIR = Path(__file__).resolve().parent / "scheduler"


def _jobs_file() -> str:
    """Jobs-file fallback chain: env -> scheduler/jobs.yaml -> jobs.example.yaml."""
    configured = os.getenv("SWARM_JOBS_FILE")
    if configured:
        return configured
    default = _SCHED_DIR / "jobs.yaml"
    return str(default if default.exists() else _SCHED_DIR / "jobs.example.yaml")


def _memory_entries() -> list:
    """The swarm memory entry list, or [] when missing/unreadable/non-list."""
    path = Path(
        os.getenv("SWARM_MEMORY_PATH", "~/.openswarm/swarm_memory.json")
    ).expanduser()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _clamp_limit(limit: int) -> int:
    return max(1, min(200, limit))


# The scheduler readers skip malformed JSON lines but open the ledgers strict-
# utf-8, so byte-level corruption (torn write, binary garbage) — or a ledger
# path that is a directory — raises and would 500 the endpoint. Degrade to []
# instead, matching the _memory_entries pattern and the "never 500" contract.
def _run_records(limit=None) -> list:
    try:
        return run_store.read_records(None, limit=limit)
    except (OSError, UnicodeDecodeError):
        return []


def _notification_records(limit=None) -> list:
    try:
        return swarm_notify.read_notifications(None, limit=limit)
    except (OSError, UnicodeDecodeError):
        return []


def _is_today(record: dict) -> bool:
    """True when the record's ``ts`` starts with the local date's ISO prefix."""
    today = datetime.date.today().isoformat()
    return str(record.get("ts") or "").startswith(today)


def _num(value) -> float:
    """Coerce a record field to a number for summing (bools/None/strings -> 0)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return value


@app.get("/metrics")
async def metrics():
    records = [r for r in _run_records() if isinstance(r, dict)]
    today_records = [r for r in records if _is_today(r)]
    ok = sum(1 for r in records if r.get("status") == "ok")

    entries = [e for e in _memory_entries() if isinstance(e, dict)]
    briefs = sum(1 for e in entries if e.get("kind") == "brief")
    campaigns = sum(1 for e in entries if e.get("kind") == "campaign")

    notifications = [
        n for n in _notification_records() if isinstance(n, dict)
    ]

    try:
        jobs = jobs_core.load_jobs(_jobs_file())
    except Exception:  # noqa: BLE001 - missing/malformed jobs file -> 0, never 500
        jobs = []

    return {
        "runs": {
            "today": len(today_records),
            "total": len(records),
            "ok": ok,
            "fail": len(records) - ok,
            "fail_today": sum(1 for r in today_records if r.get("status") != "ok"),
        },
        "tokens_today": sum(_num(r.get("tokens")) for r in today_records),
        "tokens_total": sum(_num(r.get("tokens")) for r in records),
        "cost_total": sum(_num(r.get("cost")) for r in records),
        "memory": {
            "facts": len(entries) - briefs - campaigns,
            "briefs": briefs,
            "campaigns": campaigns,
        },
        "notifications": {
            "total": len(notifications),
            "today": sum(1 for n in notifications if _is_today(n)),
        },
        "jobs": len(jobs),
    }


@app.get("/runs")
async def runs(limit: int = 20):
    records = _run_records(limit=_clamp_limit(limit))
    return {"runs": [r for r in records if isinstance(r, dict)]}


@app.get("/jobs")
async def jobs():
    path = _jobs_file()
    try:
        loaded = jobs_core.load_jobs(path)
    except Exception as exc:  # noqa: BLE001 - missing/malformed file, never 500
        return {"jobs": [], "file": path, "error": str(exc)}
    return {"jobs": loaded, "file": path}


@app.get("/notifications")
async def notifications(limit: int = 20):
    records = _notification_records(limit=_clamp_limit(limit))
    return {"notifications": [n for n in records if isinstance(n, dict)]}


# --- /config + Claude Code usage endpoints (/cc/*) -----------------------------
#
# Read-only views over ~/.claude/projects transcripts via cc_usage (ported from
# cc-dashboard-app aimd/cc). Same conventions as the dashboard endpoints above:
# fixed shapes, degrade to empty shapes, never 500. Unlike the tiny ledgers,
# a cold transcript sweep can chew through hundreds of MB of JSONL, so every
# /cc reader runs in a worker thread (asyncio.to_thread) instead of blocking
# the event loop under /chat/stream; cc_usage's (path, mtime, size) cache
# makes warm hits stat-only.

# Session ids are uuid/hex-ish transcript filenames. Anything outside this
# alphabet (dots, slashes, %-escapes already decoded by the router) is rejected
# before it can touch the filesystem, so {id} can never traverse.
# fullmatch + \Z (not $): $ would also match before a trailing newline, letting
# '/cc/usage/abc%0A' through validation with session_id='abc\n'.
_CC_SESSION_ID_RE = re.compile(r"[A-Za-z0-9_-]+\Z")


@app.get("/config")
async def config():
    """Effective backend configuration for the Settings view.

    NEVER the token value — only whether one is set.
    """
    token_present = bool(os.getenv("ATELIER_TOKEN", ""))
    try:
        max_turns = int(os.getenv("ATELIER_MAX_TURNS", "40"))
    except ValueError:
        max_turns = 40
    return {
        "model": _resolved_model(),
        "max_turns": max_turns,
        # lite_server neither spawns nor monitors the scheduler sidecar
        # (main.js does), so it cannot honestly know whether it is running:
        # null = "unknown" and the UI renders it as such.
        "scheduler": {"running": None},
        "jobs_file": os.getenv("SWARM_JOBS_FILE") or "",
        "auth_mode": "token" if token_present else "origin-gate",
        "token_present": token_present,
    }


@app.get("/cc/status")
async def cc_status():
    try:
        return await asyncio.to_thread(cc_usage.status_summary)
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return cc_usage.empty_status()


@app.get("/cc/usage")
async def cc_usage_list(limit: int = 20):
    try:
        return await asyncio.to_thread(cc_usage.recent_sessions, _clamp_limit(limit))
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return []


@app.get("/cc/usage/{session_id}")
async def cc_usage_detail(session_id: str):
    if not _CC_SESSION_ID_RE.fullmatch(session_id):
        # Invalid id: the empty shape, with the hostile string NOT echoed back.
        return cc_usage.empty_session_detail("")
    try:
        data = await asyncio.to_thread(cc_usage.session_detail, session_id)
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        data = cc_usage.empty_session_detail(session_id)
    if data is None:  # valid id, no such transcript
        return JSONResponse(
            cc_usage.empty_session_detail(session_id), status_code=404
        )
    return data


@app.get("/cc/aggregate")
async def cc_aggregate():
    try:
        return await asyncio.to_thread(cc_usage.aggregate_summary)
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return cc_usage.empty_aggregate()


@app.get("/cc/heatmap")
async def cc_heatmap():
    try:
        return await asyncio.to_thread(cc_usage.heatmap_summary)
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return cc_usage.empty_heatmap()


@app.post("/chat")
async def chat(req: ChatRequest):
    """Conversational turn on the ONE long-lived chat client (in-process memory).

    The SDK is async-native, so we await it directly (no threadpool for the
    agent call; the tool run() calls are threaded inside the wrapper). The lock
    serializes concurrent /chat calls onto the single conversation.
    """
    try:
        async with _chat_lock:
            client = await _get_chat_client()
            await client.query(req.message)
            return await _collect_response(client)
    except Exception as exc:  # noqa: BLE001 - never 500 the UI
        # The turn failed; the long-lived client may now be wedged (dead CLI
        # subprocess / broken transport). Tear it down so the NEXT /chat call
        # reconnects instead of re-raising forever.
        await _reset_chat_client()
        return {
            "response": f"Atelier hit an error and could not finish that turn: {exc}",
            "error": True,
        }


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


async def _stream_turn(message: str):
    """SSE generator for one chat turn: token deltas, then a canonical final.

    Events: {"delta": "<text>"} per text_delta, then exactly one
    {"done": true, "response": "<full text>", "error"?: true}. The final
    response is rebuilt from the complete AssistantMessage TextBlocks, so the
    client can replace its accumulated deltas with the canonical text.

    The chat lock is held for the WHOLE stream — that is what serializes the
    single conversation, same as /chat. On failure the client is torn down so
    the next turn reconnects (mirrors chat()).
    """
    failed = False
    try:
        async with _chat_lock:
            client = await _get_chat_client()
            await client.query(message)
            texts: list[str] = []
            async for msg in client.receive_response():
                if isinstance(msg, StreamEvent):
                    ev = msg.event or {}
                    if ev.get("type") == "content_block_delta":
                        delta = ev.get("delta") or {}
                        # thinking_delta / signature_delta are internal; only
                        # surface real text.
                        if delta.get("type") == "text_delta" and delta.get("text"):
                            yield _sse({"delta": delta["text"]})
                elif isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, TextBlock):
                            texts.append(block.text)
                elif isinstance(msg, ResultMessage):
                    if msg.is_error:
                        detail = msg.result or (
                            "; ".join(msg.errors) if msg.errors else "run failed"
                        )
                        yield _sse(
                            {
                                "done": True,
                                "error": True,
                                "response": (
                                    "Atelier hit an error and could not finish "
                                    f"that turn: {detail}"
                                ),
                            }
                        )
                        return
            yield _sse({"done": True, "response": "".join(texts).strip()})
    except Exception as exc:  # noqa: BLE001 - surface as an SSE error event
        failed = True
        yield _sse(
            {
                "done": True,
                "error": True,
                "response": (
                    f"Atelier hit an error and could not finish that turn: {exc}"
                ),
            }
        )
    # ponytail: a client that disconnects MID-turn leaves the session mid-flight;
    # the next turn's query() may find it wedged and trip this same reset via
    # chat()'s error path. Proactive cancellation handling is the upgrade.
    if failed:
        await _reset_chat_client()


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """Streaming variant of /chat: SSE token deltas on the same conversation."""
    return StreamingResponse(
        _stream_turn(req.message),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/open-swarm/get_response")
async def get_response_compat(req: AgencyResponseRequest):
    """Scheduler compat route: the agency server's POST /{agency}/get_response.

    scheduler/client.py fires each job here as {"message", "recipient_agent"?}.
    Every call runs on a FRESH ClaudeSDKClient — never the long-lived chat
    client — so a scheduled 7am brief cannot pollute the user's chat context,
    and it is safe to run concurrently with /chat. recipient_agent is accepted
    for API parity but ignored (single agent).
    """
    try:
        async with ClaudeSDKClient(options=build_options()) as client:
            await client.query(req.message)
            return await _collect_response(client)
    except Exception as exc:  # noqa: BLE001 - mirror /chat: never 500 the caller
        return {
            "response": f"Atelier hit an error and could not finish that turn: {exc}",
            "error": True,
        }


# --- Multi-card agent sessions ------------------------------------------------
#
# Each Agent card in the desktop app owns ONE of these sessions: a fresh
# conversation on its own ClaudeSDKClient (same build_options() isolation as
# /chat and the compat route, but a separate client from BOTH — a card can
# never pollute the main chat context or a scheduled job's).
#
# Shape (fixed contract with app/sessions.js + tests):
#   POST   /sessions                {"name"?}    -> {"id","name"}
#   GET    /sessions                             -> {"sessions":[{id,name,status,messages_len}]}
#   GET    /sessions/{id}                        -> {id,name,status,messages:[{role,text,ts}]}
#   POST   /sessions/{id}/message   {"message"}  -> 202 {"status":"running"} (fire-and-poll)
#   DELETE /sessions/{id}                        -> {"ok":true}
#   unknown id -> 404 {"error":"unknown session"}; a turn error sets
#   status "error" + an assistant message carrying the error text — never a 500.
#
# ponytail: in-memory sessions; disk persistence is the upgrade.


class _AgentSession:
    """One card-scoped conversation: lazy client + status + message ledger."""

    def __init__(self, session_id: str, name: str):
        self.id = session_id
        self.name = name
        self.client: ClaudeSDKClient | None = None  # lazy: built on first message
        self.lock = asyncio.Lock()
        self.status = "idle"  # "idle" | "running" | "error"
        self.messages: list[dict] = []  # {"role","text","ts"} append-only
        self.last_used = next(_session_touch)


_sessions: dict[str, _AgentSession] = {}
_session_seq = itertools.count(1)    # 'Agent N' default names
_session_touch = itertools.count(1)  # deterministic LRU clock (no wall-time ties)
# Strong refs to in-flight turn tasks; asyncio only holds weak ones.
_session_tasks: set = set()


def _max_sessions() -> int:
    """The session cap, read from env at call time so tests can tune it."""
    try:
        return max(1, int(os.getenv("ATELIER_MAX_SESSIONS", "6")))
    except ValueError:
        return 6


def _touch_session(sess: _AgentSession) -> None:
    sess.last_used = next(_session_touch)


def _session_ts() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


# Per-session ledger ceiling: session COUNT is capped by ATELIER_MAX_SESSIONS,
# but each ledger is append-only in-memory, so it needs its own ceiling too.
# Reject (never silently drop) — the poller's rendered-count cursor assumes the
# list only ever grows. ponytail: 500 messages/session, deliberate; a card that
# deep should be closed for a fresh one, and disk persistence is the upgrade.
_MAX_SESSION_MESSAGES = 500


def _append_session_message(sess: _AgentSession, role: str, text: str) -> None:
    sess.messages.append({"role": role, "text": text, "ts": _session_ts()})


def _unknown_session() -> JSONResponse:
    return JSONResponse({"error": "unknown session"}, status_code=404)


async def _close_session_client(sess: _AgentSession) -> None:
    """Best-effort disconnect + drop of a session's client (may be None)."""
    client, sess.client = sess.client, None
    if client is not None:
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001 - teardown must never propagate
            pass


async def _spawn_session_turn(coro) -> None:
    """Fire-and-forget one turn. Tests monkeypatch this to await inline."""
    task = asyncio.create_task(coro)
    _session_tasks.add(task)
    task.add_done_callback(_session_tasks.discard)


async def _run_session_turn(sess: _AgentSession, message: str) -> None:
    """One fire-and-poll turn: query, drain via _collect_response, settle status.

    The caller already appended the user message and set status "running";
    this appends the assistant message (or the error-text assistant message)
    and settles status to "idle"/"error". Reuses _collect_response so the
    TextBlock/ResultMessage drain semantics can never drift from /chat.
    """
    async with sess.lock:
        # A DELETE can land between spawn and here: the session is already out
        # of _sessions and its client (if any) disconnected. Bail before
        # building a NEW client — otherwise the turn would run at real token
        # cost on a detached session nobody can reach, and its freshly
        # connected client would leak (lifespan teardown only walks _sessions).
        if _sessions.get(sess.id) is not sess:
            sess.status = "idle"
            await _close_session_client(sess)
            return
        try:
            if sess.client is None:
                client = ClaudeSDKClient(options=build_options())
                await client.connect()
                sess.client = client
            await sess.client.query(message)
            result = await _collect_response(sess.client)
            _append_session_message(sess, "assistant", result["response"])
            sess.status = "error" if result.get("error") else "idle"
        except Exception as exc:  # noqa: BLE001 - surface in-band, never crash the task
            _append_session_message(
                sess,
                "assistant",
                f"Atelier hit an error and could not finish that turn: {exc}",
            )
            sess.status = "error"
            # The transport may be wedged (dead CLI subprocess); drop the client
            # so the next message reconnects fresh — mirrors _reset_chat_client.
            await _close_session_client(sess)
        finally:
            _touch_session(sess)
            # Deleted MID-turn: delete_session's disconnect may have raced our
            # lazy connect above, leaving a live client on the detached object.
            if _sessions.get(sess.id) is not sess:
                await _close_session_client(sess)


class SessionCreateRequest(BaseModel):
    name: str | None = None


class SessionMessageRequest(BaseModel):
    # ponytail: 200k-char ceiling — far past any real prompt, small enough that
    # a hostile local client cannot balloon resident memory one POST at a time.
    message: str = Field(max_length=200_000)


@app.post("/sessions")
async def create_session(req: SessionCreateRequest | None = None):
    # Cap with LRU eviction: evictable = any session NOT mid-turn ("idle" or
    # "error" — an errored card is just as reclaimable). All running -> 409.
    while len(_sessions) >= _max_sessions():
        evictable = [s for s in _sessions.values() if s.status != "running"]
        if not evictable:
            return JSONResponse({"error": "session limit"}, status_code=409)
        victim = min(evictable, key=lambda s: s.last_used)
        _sessions.pop(victim.id, None)
        await _close_session_client(victim)

    name = ((req.name if req else None) or "").strip() or f"Agent {next(_session_seq)}"
    sess = _AgentSession(uuid.uuid4().hex, name)
    _sessions[sess.id] = sess
    return {"id": sess.id, "name": sess.name}


@app.get("/sessions")
async def list_sessions():
    return {
        "sessions": [
            {
                "id": s.id,
                "name": s.name,
                "status": s.status,
                "messages_len": len(s.messages),
            }
            for s in _sessions.values()
        ]
    }


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    sess = _sessions.get(session_id)
    if sess is None:
        return _unknown_session()
    return {
        "id": sess.id,
        "name": sess.name,
        "status": sess.status,
        "messages": list(sess.messages),
    }


@app.post("/sessions/{session_id}/message")
async def session_message(session_id: str, req: SessionMessageRequest):
    sess = _sessions.get(session_id)
    if sess is None:
        return _unknown_session()
    if sess.status == "running":
        return JSONResponse({"error": "turn in progress"}, status_code=409)
    # +1 leaves room for the assistant reply this turn will append.
    if len(sess.messages) + 1 >= _MAX_SESSION_MESSAGES:
        return JSONResponse({"error": "session ledger full"}, status_code=413)
    _append_session_message(sess, "user", req.message)
    sess.status = "running"
    _touch_session(sess)
    await _spawn_session_turn(_run_session_turn(sess, req.message))
    return JSONResponse({"status": "running"}, status_code=202)


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    sess = _sessions.pop(session_id, None)
    if sess is None:
        return _unknown_session()
    # ponytail: deleting a RUNNING session disconnects under the in-flight turn;
    # the turn task lands on the detached object and is garbage-collected.
    # Both race orderings are covered in _run_session_turn: a turn that has not
    # started yet bails before connecting, and a turn that connected AFTER this
    # disconnect drops its client in its finally block.
    await _close_session_client(sess)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.getenv("PORT", "8765")),
        log_level="warning",
    )
