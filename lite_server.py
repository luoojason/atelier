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
import json
import os
import re
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

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel


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


app = FastAPI(title="Atelier Lite", lifespan=_lifespan)

# Local-only server, but allow_origins=["*"] would let ANY web page — in the
# user's regular browser, or loaded inside the app's own browser card — read
# /runs//jobs//metrics//notifications and drive POST /chat (drive-by prompt
# injection). Legitimate callers are: the Electron renderer / a file:// test
# page (Origin "null" or "file://"), local dev pages, and no-Origin clients
# (curl, main.js's Node fetch, TestClient). Everything else is rejected
# server-side too, since CORS alone only hides the response.
# ponytail: origin gating in v1 — a shared-secret header minted by main.js and
# threaded through preload + spawn env is the upgrade path.
_ORIGIN_RE = r"^(null|file://|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"
_origin_ok = re.compile(_ORIGIN_RE).match

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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.getenv("PORT", "8765")),
        log_level="warning",
    )
