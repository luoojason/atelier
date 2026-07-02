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
import dataclasses
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
    create_sdk_mcp_server,
    tool,
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
    WebSearch,
    WebFetch,
    NotionSearch,
    NotionRead,
    NotionCreatePage,
    NotionAppend,
)
from shared_tools import sdk_tools
from shared_tools.sdk_tools import build_atelier_server

# Pure stdlib vault path helpers: the /versions* routes validate note paths
# against the vault root without touching the heavier tool wrappers.
from shared_tools import vault_core
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
- You can search the web with WebSearch and read a page's text with WebFetch — use them for anything requiring current or external information.

Be concise. When you take an action with a tool, say plainly what you did and cite the note path, brief, or campaign id involved. Do not claim to have published or shipped anything that has not passed its gate.

If a task needs a tool or capability you do not have, or a tool returns an error or no results, say so plainly. NEVER present training-knowledge as if it were searched, fetched, or retrieved — do not fabricate sources, URLs, or live data.

When SpawnAgent/CheckAgent are available you can delegate a subtask to a parallel sub-agent and collect its result later; sub-agents run as their own isolated sessions. When DelegateToSubagent is available you govern one or more existing sub-agent cards; call it with a governed card's id or name to hand it a subtask and get its reply back inline."""

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
    WebSearch,
    WebFetch,
    NotionSearch,
    NotionRead,
    NotionCreatePage,
    NotionAppend,
]

# One in-process MCP server ("atelier") wrapping all 10 BaseTool subclasses as
# native SDK tools, plus the mcp__atelier__<ClassName> allowlist for the agent.
ATELIER_SERVER, ATELIER_ALLOWED_TOOLS = build_atelier_server(LIGHT_TOOLS)

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


# --- Provider + model settings store --------------------------------------------
#
# One tiny JSON file holds the user's provider choice, optional API key, and
# optional model choice:
#   {"provider": "subscription"|"api", "anthropic_api_key": "<str>", "model": "<str>"}
# Read at CALL time (no caching) so a settings change is picked up by the very
# next build_options() without a restart. Every failure mode — missing file,
# corrupt JSON, wrong types, unknown provider — degrades to the safe default
# {"provider": "subscription"} with no key; loading NEVER raises.


def _settings_path() -> Path:
    return Path(
        os.getenv("ATELIER_SETTINGS_PATH") or "~/.atelier/settings.json"
    ).expanduser()


def load_settings() -> dict:
    """The persisted provider settings, degraded to a safe default on any failure."""
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"provider": "subscription"}
    if not isinstance(data, dict):
        return {"provider": "subscription"}
    settings = {"provider": "subscription"}
    if data.get("provider") in ("subscription", "api"):
        settings["provider"] = data["provider"]
    key = data.get("anthropic_api_key")
    if isinstance(key, str) and key:
        settings["anthropic_api_key"] = key
    # "model" must ride along here: every mutating route merges via
    # load_settings() -> save_settings(), so a model filtered out on load
    # would be silently wiped by the very next provider/api-key write.
    # Non-empty str only; the allowlist gate lives on POST /config/model
    # (a hand-edited value still resolves, and the Settings UI renders it
    # as a disabled custom segment).
    model = data.get("model")
    if isinstance(model, str) and model:
        settings["model"] = model
    notion = data.get("notion_token")
    if isinstance(notion, str) and notion:
        settings["notion_token"] = notion
    vault = data.get("obsidian_vault")
    if isinstance(vault, str) and vault:
        settings["obsidian_vault"] = vault
    return settings


def save_settings(d: dict) -> None:
    """Atomic write (tmp + os.replace) with the final file chmod'd 0600.

    The tmp file is CREATED 0600 (not chmod'd after the write) so the settings
    file — which can hold a real API key — is never observable with looser
    perms, not even between create and write.
    """
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        os.fchmod(fd, 0o600)  # O_CREAT's mode is skipped on a leftover tmp
        f.write(json.dumps(d, indent=2))
    os.replace(tmp, path)


def _effective_provider(settings: dict | None = None) -> str:
    """'api' ONLY when chosen AND a key is stored; else 'subscription' (no dead state)."""
    s = load_settings() if settings is None else settings
    if s.get("provider") == "api" and s.get("anthropic_api_key"):
        return "api"
    return "subscription"


def _resolved_model() -> str:
    """The SDK model string: settings["model"] else CLAUDE_CLI_MODEL else "sonnet".

    The persisted picker choice wins so the Settings UI is authoritative; the
    env knob stays as the headless override; "sonnet" is the floor. Read at
    CALL time like every other settings consumer (no restart needed).
    """
    return (
        load_settings().get("model")
        or os.getenv("CLAUDE_CLI_MODEL")
        or "sonnet"
    )


def build_options(
    stream: bool = False,
    spawner_session_id: str | None = None,
    delegator_session_id: str | None = None,
    model: str | None = None,
) -> ClaudeAgentOptions:
    """The single builder for BOTH the /chat client and every compat request.

    Resolves model + isolation env + the atelier MCP server + allowed_tools +
    setting_sources in ONE place so the chat session and the scheduler's fresh
    per-request sessions can never drift.

    ``stream=True`` enables include_partial_messages so /chat/stream can emit
    token deltas. Harmless for the non-streaming drain (it ignores StreamEvent).

    ``spawner_session_id``: when set, this run belongs to a depth-0 agent-card
    session and gains a per-call "orchestra" MCP server (SpawnAgent/CheckAgent/
    NavigateBrowser bound to that session id). The chat client, the compat
    route, and depth-1 sub-agent sessions all pass None, so sub-agents
    structurally cannot spawn their own sub-agents.

    Isolation (unconditional for the app agent): a private CLAUDE_CONFIG_DIR
    (respect an existing override, else ~/.atelier/claude-home, created if
    missing), an empty CLAUDE_SECURESTORAGE_CONFIG_DIR (keeps Max OAuth on the
    default Keychain item), stripped inherited API keys, and setting_sources=[]
    (no CLAUDE.md / hooks / plugins / skills / auto-memory).

    Provider (dual auth): with settings provider "api" AND a stored key, the
    isolation env carries ANTHROPIC_API_KEY=<key> instead (auth token still
    stripped) so the CLI bills the user's own API key; otherwise both are
    stripped (empty-string overrides — see the comment at the strip site) and
    the run stays on the Max OAuth login.
    """
    config_dir = os.environ.get(
        "CLAUDE_CONFIG_DIR", os.path.expanduser("~/.atelier/claude-home")
    )
    os.makedirs(config_dir, exist_ok=True)

    settings = load_settings()

    env = {k: v for k, v in os.environ.items()}
    # Strip any inherited API/auth keys so the run stays on the Max OAuth
    # login. These MUST be empty-string overrides, not pops: the SDK transport
    # spawns the CLI with {**os.environ, **options.env}, so a key merely
    # popped here resurrects from the inherited process env and silently
    # bills the user's API key while the UI reports "subscription". The CLI
    # treats an empty value as unset (verified live: a bogus inherited key
    # hijacks auth with "Invalid API key"; "" falls back to the OAuth login).
    env["ANTHROPIC_API_KEY"] = ""
    env["ANTHROPIC_AUTH_TOKEN"] = ""
    if _effective_provider(settings) == "api":
        env["ANTHROPIC_API_KEY"] = settings["anthropic_api_key"]
    env["CLAUDE_CONFIG_DIR"] = config_dir
    env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = ""

    mcp_servers = {"atelier": ATELIER_SERVER}
    # Notion tools are gated on a stored token (removed here, re-added below).
    allowed_tools = [t for t in ATELIER_ALLOWED_TOOLS if t not in NOTION_TOOL_NAMES]
    system_prompt = ATELIER_INSTRUCTIONS
    if settings.get("notion_token"):
        allowed_tools += NOTION_TOOL_NAMES
        system_prompt += _NOTION_PROMPT

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
                system_prompt
                + "\n\nYou govern these sub-agent cards: "
                + roster
                + ". Use DelegateToSubagent(subagent, task) to hand a subtask"
                " to one of them by id or name; the sub-agent runs it and its"
                " reply is returned to you."
            )

    return ClaudeAgentOptions(
        model=model or _resolved_model(),
        system_prompt=system_prompt,
        mcp_servers=mcp_servers,
        allowed_tools=allowed_tools,
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

# The vault GETs are the one read surface that's NOT safe to leave open like
# the rest of the read-only GETs above: /vault/graph + /vault/note expose the
# whole Obsidian vault's link graph and note contents, so a hostile "null"
# origin page (CORS-allowed for the Electron renderer) could exfiltrate it
# cross-origin. Every other GET stays ungated per the accepted-risk note
# above; these two get the same token gate the mutating methods use.
_TOKEN_GATED_GET_PATHS = ("/vault/graph", "/vault/note")

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
    needs_token = (
        request.method in _MUTATING_METHODS
        or request.url.path in _TOKEN_GATED_GET_PATHS
    )
    if token and needs_token:
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
    provider = _effective_provider()
    return {
        "ok": True,
        "model": _resolved_model(),
        # Kept a bool for existing consumers; true exactly when the effective
        # provider is the Max subscription.
        "subscription": provider == "subscription",
        "provider": provider,
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


def _interval_anchor(last_run_ts, now):
    """The job's newest ledger fire as an aware datetime <= now, or None.

    The ledger writes naive local ISO timestamps (run_store.build_record gets
    datetime.now().isoformat()); a naive parse is localized. Unparsable or
    future (clock skew) timestamps are ignored — the caller falls back to the
    unanchored trigger.
    """
    if not last_run_ts:
        return None
    try:
        anchor = datetime.datetime.fromisoformat(str(last_run_ts))
    except ValueError:
        return None
    if anchor.tzinfo is None:
        anchor = anchor.astimezone()
    return anchor if anchor <= now else None


def _fire_times(job: dict, last_run_ts=None) -> tuple:
    """``(next_fire, fire_after)`` for one job dict, or ``(None, None)``.

    Builds the SAME trigger the scheduler daemon builds (jobs_core.build_trigger
    -> CronTrigger / IntervalTrigger, see scheduler.build_scheduler), asks it
    for the next fire after now, then feeds that fire back in as the previous
    one to get the fire after that. Values are ISO local-time strings at
    seconds precision (with the UTC offset the triggers' aware datetimes
    carry). Wrapped per job: a bad or never-firing schedule yields nulls and
    can never 500 the route or disturb the other jobs' entries.

    For an interval job the daemon anchors the cadence at its own start time,
    which this process cannot know. The closest in-process proxy is the job's
    newest runs-ledger fire (``last_run_ts``): anchoring the trigger's
    start_date there makes next_fire the real fire + N*interval — exact once
    the job has fired under the running daemon, and STABLE across requests
    (a fresh unanchored IntervalTrigger re-anchors at construction, so every
    request would report now + interval and a countdown that never advances).
    A job with no ledger history falls back to now + interval; fire_after is
    one interval later either way, so the spacing is always real.
    """
    try:
        from apscheduler.triggers.cron import CronTrigger
        from apscheduler.triggers.interval import IntervalTrigger

        spec = jobs_core.build_trigger(job)
        now = datetime.datetime.now().astimezone()
        if spec["type"] == "interval":
            trigger = IntervalTrigger(
                seconds=spec["seconds"],
                start_date=_interval_anchor(last_run_ts, now),
            )
        else:
            trigger = CronTrigger(**spec["fields"])
        next_fire = trigger.get_next_fire_time(None, now)
        if next_fire is None:
            return None, None
        fire_after = trigger.get_next_fire_time(next_fire, next_fire)
    except Exception:  # noqa: BLE001 - a bad schedule yields nulls, never a 500
        return None, None
    return (
        next_fire.isoformat(timespec="seconds"),
        fire_after.isoformat(timespec="seconds") if fire_after else None,
    )


@app.get("/jobs")
async def jobs():
    path = _jobs_file()
    try:
        loaded = jobs_core.load_jobs(path)
    except Exception as exc:  # noqa: BLE001 - missing/malformed file, never 500
        return {"jobs": [], "file": path, "error": str(exc)}
    # Newest ledger fire per job name — the interval-cadence anchor for
    # _fire_times (records come back oldest-first, so the last write wins).
    # _run_records degrades to [] on any read failure, keeping never-500.
    last_runs: dict = {}
    for record in _run_records():
        if isinstance(record, dict) and record.get("name") and record.get("ts"):
            last_runs[str(record["name"])] = str(record["ts"])
    out = []
    for job in loaded:
        entry = dict(job)
        entry["next_fire"], entry["fire_after"] = _fire_times(
            job, last_runs.get(str(job.get("name")))
        )
        out.append(entry)
    return {"jobs": out, "file": path}


@app.get("/notifications")
async def notifications(limit: int = 20):
    records = _notification_records(limit=_clamp_limit(limit))
    return {"notifications": [n for n in records if isinstance(n, dict)]}


@app.get("/campaigns")
async def campaigns(limit: int = 20):
    """The stored campaign entries, newest first. Read-only, never 500s.

    Filters the SAME _memory_entries() source /metrics counts by, down to
    kind == "campaign". Stored entry shape (written by campaign_core.
    save_campaign, the store CampaignStatus reads back): {"ts", "kind":
    "campaign", "text": <the goal>, "project", "id", "campaign": {"id",
    "goal", "project", "brief", "stage", "created_ts", "deliverables":
    [{"type", "spec", "status", "path", "verdict"}]}}. Entries pass through
    verbatim — they are locally produced by the campaign tools — and the
    store is append-only, so the last entry is the newest.
    """
    entries = [
        e
        for e in _memory_entries()
        if isinstance(e, dict) and e.get("kind") == "campaign"
    ]
    entries.reverse()  # append-only store: newest last -> newest first
    return {"campaigns": entries[: _clamp_limit(limit)]}


# --- Jobs editing endpoints (POST /jobs + DELETE /jobs/{name}) -------------------
#
# Token-gated writes (POST/DELETE -> the middleware) against the USER jobs
# file only: with SWARM_JOBS_FILE unset, _jobs_file() falls back to files
# inside the repo checkout, and editing those would silently mutate the
# install — both routes refuse with 409 instead. The write path round-trips
# the loaded YAML structure and only ever touches the one edited/deleted
# entry, so unknown keys — and even invalid sibling jobs the daemon's lenient
# loader skips — survive an edit untouched (yaml comments are the one
# accepted loss). The edited entry is validated with the SAME
# jobs_core.validate_job the scheduler daemon applies at load time, so
# nothing this route accepts can later fail to schedule.

# The two job shapes the editor can write; "builtin:digest" maps to the job
# dict {"builtin": "digest"} (see jobs_core.BUILTIN_JOBS).
_JOB_TYPES = ("prompt", "builtin:digest")

# The scheduler daemon's internal APScheduler ids live in the same id
# namespace as user job names (add_job(id=job["name"])), so these are
# rejected as job names. Mirrors scheduler.scheduler.RELOAD_JOB_ID and the
# schedule_catch_ups "catch-up:<name>" one-shot ids; hardcoded here rather
# than imported so the web process never pulls in the daemon module.
_RELOAD_JOB_ID = "__jobs-file-reload__"
_CATCH_UP_PREFIX = "catch-up:"


class JobUpsertRequest(BaseModel):
    # Defaults keep shape problems inside the handler's own 400 path (with
    # human-readable reasons) instead of FastAPI's 422 for absent fields.
    name: str = ""
    schedule: str = ""
    prompt: str = ""
    type: str = "prompt"


def _user_jobs_file() -> str | None:
    """The user-configured jobs file, or None on the (read-only) repo fallback."""
    return os.getenv("SWARM_JOBS_FILE") or None


def _load_jobs_doc(path: str) -> tuple:
    """The raw parsed YAML jobs document, round-trip friendly.

    Returns ``(doc, raw_jobs)`` where raw_jobs is the mutable list INSIDE doc,
    so in-place edits write back through doc without re-serializing any other
    entry. A missing or empty file starts the seed template's shape
    ({"jobs": []}); a file that will not parse, or whose top level is neither
    a list nor a mapping with a "jobs:" list, raises ValueError. Any OSError
    other than "file not found" propagates: a momentarily unreadable file
    (permissions, EIO) still HOLDS the user's jobs, and starting an empty doc
    here would let the caller's atomic write (which only needs directory
    write permission) replace the whole file with just the edited entry.
    """
    import yaml

    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        doc: dict = {"jobs": []}
        return doc, doc["jobs"]
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError(f"jobs file could not be parsed: {exc}") from exc
    if data is None:
        doc = {"jobs": []}
        return doc, doc["jobs"]
    if isinstance(data, list):
        return data, data
    if isinstance(data, dict) and "jobs" in data:
        if data["jobs"] is None:  # a bare "jobs:" line
            data["jobs"] = []
        if isinstance(data["jobs"], list):
            return data, data["jobs"]
    raise ValueError(
        "jobs file must be a YAML list of jobs (or a mapping with a 'jobs:' list)"
    )


def _write_jobs_doc(path: str, doc) -> None:
    """Atomic write (tmp + os.replace), the same pattern as save_settings."""
    import yaml

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(
        yaml.safe_dump(doc, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    os.replace(tmp, target)


def _raw_name_matches(item, name: str) -> bool:
    """True when a raw yaml entry's name matches ``name`` as load_jobs sees it
    (validate_job strips string fields, so match on the stripped form)."""
    return isinstance(item, dict) and str(item.get("name") or "").strip() == name


@app.post("/jobs")
async def upsert_job(req: JobUpsertRequest):
    """Create or update one job by name. Token-gated (POST).

    400 {"error": reason} on anything invalid; 409 when no user jobs file is
    configured (the repo fallback must never be written).
    """
    path = _user_jobs_file()
    if path is None:
        return JSONResponse(
            {"error": "no user jobs file configured"}, status_code=409
        )

    name = req.name.strip()
    if not name:
        return JSONResponse({"error": "name must not be empty"}, status_code=400)
    if len(name) > 100:
        return JSONResponse(
            {"error": "name too long (max 100 characters)"}, status_code=400
        )
    if "\n" in name or "\r" in name:
        return JSONResponse(
            {"error": "name must not contain newlines"}, status_code=400
        )
    if "/" in name:
        # DELETE /jobs/{name} is a single path segment (and starlette decodes
        # %2F before routing), so a name with a slash could never be deleted
        # through the API again.
        return JSONResponse(
            {"error": "name must not contain '/'"}, status_code=400
        )
    if name == _RELOAD_JOB_ID or name.startswith(_CATCH_UP_PREFIX):
        # The daemon's internal APScheduler ids share the user-job namespace:
        # a job named after the hot-reload watcher would REPLACE it on the
        # next reload (killing hot reload until daemon restart), and the
        # "catch-up:" prefix collides with the boot catch-up one-shots. See
        # scheduler/scheduler.py (RELOAD_JOB_ID, schedule_catch_ups).
        return JSONResponse(
            {"error": "name is reserved for scheduler-internal jobs"},
            status_code=400,
        )
    if req.type not in _JOB_TYPES:
        return JSONResponse(
            {"error": 'type must be "prompt" or "builtin:digest"'}, status_code=400
        )
    if req.type == "prompt" and not req.prompt.strip():
        return JSONResponse(
            {"error": 'prompt is required for a "prompt" job'}, status_code=400
        )

    try:
        doc, raw_jobs = _load_jobs_doc(path)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except OSError as exc:
        # Unreadable (NOT missing) file: refuse rather than rebuild from empty.
        return JSONResponse(
            {"error": f"could not read jobs file: {exc}"}, status_code=500
        )

    # Merge into a copy of the entry being replaced (first match wins, same as
    # the daemon's lenient loader) so fields the form does not carry —
    # catch_up, agent, endpoint — ride through the edit instead of being
    # silently dropped. Switching type swaps the payload field (a job carries
    # exactly one of prompt|builtin).
    index = next(
        (i for i, item in enumerate(raw_jobs) if _raw_name_matches(item, name)),
        None,
    )
    merged = dict(raw_jobs[index]) if index is not None else {}
    merged["name"] = name
    merged["schedule"] = req.schedule
    if req.type == "prompt":
        merged["prompt"] = req.prompt
        merged.pop("builtin", None)
    else:
        merged["builtin"] = "digest"
        merged.pop("prompt", None)

    try:
        job = jobs_core.validate_job(merged)
    except (TypeError, ValueError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    if index is None:
        raw_jobs.append(job)
    else:
        raw_jobs[index] = job
    try:
        _write_jobs_doc(path, doc)
    except OSError as exc:
        return JSONResponse(
            {"error": f"could not write jobs file: {exc}"}, status_code=500
        )
    return {"ok": True, "job": job}


@app.delete("/jobs/{name}")
async def delete_job(name: str):
    """Remove every job entry matching ``name`` exactly. Token-gated (DELETE).

    {"ok": true} when something was removed; {"ok": false} for an unknown
    name, a missing file, or an unparseable one (nothing was removed in any
    of those cases); 409 with no user jobs file configured, same as POST.
    """
    path = _user_jobs_file()
    if path is None:
        return JSONResponse(
            {"error": "no user jobs file configured"}, status_code=409
        )
    try:
        doc, raw_jobs = _load_jobs_doc(path)
    except (ValueError, OSError):
        # Unparseable or unreadable-but-present file: nothing was removed, and
        # rebuilding from an empty doc would wipe the user's other jobs.
        return {"ok": False}
    kept = [item for item in raw_jobs if not _raw_name_matches(item, name)]
    if len(kept) == len(raw_jobs):
        return {"ok": False}
    raw_jobs[:] = kept  # in place, so the write goes back through doc
    try:
        _write_jobs_doc(path, doc)
    except OSError:
        return {"ok": False}
    return {"ok": True}


# --- Run-log endpoint (read-only tail of the desktop backend log) ---------------
#
# main.js appends the backend's stdio to ~/.atelier/logs/backend.log and rotates
# it at 5MB, so the file is always small — but the read still seeks in from the
# end and decodes at most ~1MB, never the whole file. Same conventions as the
# dashboard endpoints above: fixed shape, resolve the path from env at CALL
# time (ATELIER_BACKEND_LOG), degrade to the empty shape on any failure, never
# 500. ponytail: sync <=1MB local read inside an async handler, same deliberate
# trade as the ledger readers; asyncio.to_thread is the upgrade if it ever
# points at slow storage.

_LOG_TAIL_MAX_BYTES = 1024 * 1024  # never load more than ~1MB of the log


def _log_path() -> Path:
    return Path(
        os.getenv("ATELIER_BACKEND_LOG") or "~/.atelier/logs/backend.log"
    ).expanduser()


def _tail_lines(path: Path, n: int) -> tuple[list[str], int]:
    """The last ``n`` lines of ``path`` plus its total byte size.

    Reads only the final _LOG_TAIL_MAX_BYTES window (seek from the end) and
    decodes errors='replace', so binary garbage and a multibyte char torn by
    the window boundary both degrade to replacement chars instead of raising.
    When the window starts mid-file its first "line" can be a fragment of a
    longer one; slicing the LAST n lines discards it except in the degenerate
    case of >1KB average lines (1MB window / 1000-line max tail) — accepted.
    """
    with path.open("rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        start = max(0, size - _LOG_TAIL_MAX_BYTES)
        fh.seek(start)
        data = fh.read(size - start)
    return data.decode("utf-8", errors="replace").splitlines()[-n:], size


@app.get("/logs/backend")
async def logs_backend(tail: int = 200):
    # Its own clamp, NOT _clamp_limit: the run-log card asks for 300 lines and
    # the contract ceiling is 1000, past the dashboard readers' 200.
    n = max(1, min(1000, tail))
    path = _log_path()
    try:
        lines, size = _tail_lines(path, n)
    except OSError:  # missing file, unreadable, path-is-a-directory — never 500
        return {"lines": [], "path": str(path), "size": 0}
    return {"lines": lines, "path": str(path), "size": size}


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


def _api_key_hint(key: str) -> str:
    """The only display form a stored key ever takes: '…' + its last 4 chars."""
    return "…" + key[-4:] if key else ""


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


@app.get("/config")
async def config():
    """Effective backend configuration for the Settings view.

    NEVER the token value — only whether one is set. Same rule for the API
    key: presence + a last-4 hint only; the key itself never leaves the
    settings file (not in responses, logs, or error strings).
    """
    token_present = bool(os.getenv("ATELIER_TOKEN", ""))
    try:
        max_turns = int(os.getenv("ATELIER_MAX_TURNS", "40"))
    except ValueError:
        max_turns = 40
    settings = load_settings()
    key = settings.get("anthropic_api_key") or ""
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
        "provider": _effective_provider(settings),
        "api_key_present": bool(key),
        "api_key_hint": _api_key_hint(key),
        "notion_connected": bool(settings.get("notion_token")),
        "notion_token_hint": _notion_token_hint(settings.get("notion_token") or ""),
        "obsidian_vault": settings.get("obsidian_vault") or "",
    }


class ProviderRequest(BaseModel):
    provider: str


class ApiKeyRequest(BaseModel):
    api_key: str


class ApiKeyValidateRequest(BaseModel):
    api_key: str | None = None


# Anthropic API keys are 'sk-ant-' + a base64url-ish tail; the length band is
# deliberately loose (10..200) so future key formats keep working while junk
# ("sk-ant-x", pasted prose) is still rejected before it can be persisted.
_API_KEY_RE = re.compile(r"^sk-ant-[A-Za-z0-9_-]{10,200}$")


@app.post("/config/provider")
async def set_provider(req: ProviderRequest):
    """Persist the provider choice. POST -> token-gated by the middleware.

    _reset_chat_client() drops the long-lived chat client so the NEXT chat
    turn rebuilds on the new provider; existing agent-session clients keep
    their transport until they naturally rebuild (error teardown or delete).
    """
    if req.provider not in ("subscription", "api"):
        return JSONResponse(
            {"error": 'provider must be "subscription" or "api"'}, status_code=400
        )
    settings = load_settings()
    if req.provider == "api" and not settings.get("anthropic_api_key"):
        return JSONResponse({"error": "no API key saved"}, status_code=400)
    settings["provider"] = req.provider
    save_settings(settings)
    await _reset_chat_client()
    return {"ok": True, "provider": _effective_provider(settings)}


# The model picker's allowlist: the three CLI aliases the SDK accepts today.
# A custom CLAUDE_CLI_MODEL env value still resolves (see _resolved_model);
# this route only ever PERSISTS one of these.
_ALLOWED_MODELS = ("sonnet", "opus", "haiku")


class ModelRequest(BaseModel):
    model: str


@app.post("/config/model")
async def set_model(req: ModelRequest):
    """Persist the model choice. POST -> token-gated by the middleware.

    Same reset contract as set_provider: dropping the long-lived chat client
    means the NEXT chat turn rebuilds on the new model; existing agent-card
    sessions keep their transport and rebuild lazily (error teardown or
    delete).
    """
    if req.model not in _ALLOWED_MODELS:
        return JSONResponse({"error": "unknown model"}, status_code=400)
    settings = load_settings()
    settings["model"] = req.model
    save_settings(settings)  # merge: provider + api key ride along untouched
    await _reset_chat_client()
    return {"ok": True, "model": _resolved_model()}


@app.post("/config/api-key")
async def set_api_key(req: ApiKeyRequest):
    """Store a (shape-validated) API key. Provider choice is left untouched."""
    key = req.api_key.strip()
    if not _API_KEY_RE.match(key):
        return JSONResponse(
            {"error": "that does not look like an Anthropic API key"},
            status_code=400,
        )
    settings = load_settings()
    settings["anthropic_api_key"] = key
    save_settings(settings)
    return {
        "ok": True,
        "api_key_present": True,
        "api_key_hint": _api_key_hint(key),
    }


@app.delete("/config/api-key")
async def delete_api_key():
    """Remove the stored key; provider "api" flips to "subscription" (no dead state)."""
    settings = load_settings()
    settings.pop("anthropic_api_key", None)
    settings["provider"] = "subscription"
    save_settings(settings)
    await _reset_chat_client()
    return {"ok": True, "provider": "subscription", "api_key_present": False}


@app.post("/config/api-key/validate")
async def validate_api_key(req: ApiKeyValidateRequest | None = None):
    """Live-check a key (supplied, else stored) against the Anthropic API.

    Never 500 and never echoes the key: every outcome is a fixed
    {"valid", "detail"} shape with the key appearing only in the outbound
    x-api-key header.
    """
    supplied = (req.api_key if req else None) or ""
    key = supplied.strip() or (load_settings().get("anthropic_api_key") or "")
    if not key:
        return {"valid": False, "detail": "no key to validate"}
    # Imported here so the module never pays for (or hard-requires) httpx on
    # the paths that never validate a key.
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10.0) as hc:
            resp = await hc.get(
                "https://api.anthropic.com/v1/models",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
            )
    except Exception:  # noqa: BLE001 - DNS/refused/timeout all mean "unreachable"
        return {"valid": False, "detail": "could not reach api.anthropic.com"}
    if resp.status_code == 200:
        return {"valid": True, "detail": "key accepted"}
    if resp.status_code in (401, 403):
        return {"valid": False, "detail": "key rejected by Anthropic"}
    return {"valid": False, "detail": f"unexpected response {resp.status_code}"}


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


# --- Output version history endpoints (/versions*) ------------------------------
#
# Read/restore views over shared_tools/versions_store — the content-addressed
# captures vault_core.write_note takes of every note it overwrites. Same
# conventions as the dashboard endpoints above: fixed shapes, degrade to
# empty shapes on ANY failure, never 500. Restore is the one mutating route
# (POST -> token-gated by the middleware); the store itself re-validates
# vault containment + the Sources/ ban before touching the file.

# Version ids are hex content digests (sha256 today; a shorter prefix
# tomorrow). Anything outside 8..64 lowercase hex chars is rejected before it
# can reach the store, so {id} can never traverse or probe. fullmatch (never
# $): $ would also match before a trailing newline.
_VERSION_ID_RE = re.compile(r"[a-f0-9]{8,64}")


def _versions_store():
    """The versions store module, imported at CALL time.

    Kept out of the module-level imports so a missing or broken store can
    never take the whole server down — every /versions* handler wraps its
    store use in try/except and degrades to its empty shape instead.
    """
    from shared_tools import versions_store

    return versions_store


def _vault_note_path(raw: str) -> str | None:
    """``raw`` unchanged when it resolves INSIDE the vault root, else None.

    Resolution (symlinks + '..' collapsed) happens before the containment
    check, so traversal tricks cannot slip a foreign path through — but the
    ORIGINAL string is what gets returned and handed to the store, because
    the store keys notes by the exact path string capture() saw and the
    Versions card only ever echoes paths the store itself listed. Callers
    treat None as "reject": empty shape, hostile path never echoed back.
    """
    if not raw:
        return None
    try:
        root = vault_core.vault_root().resolve()
        Path(raw).expanduser().resolve().relative_to(root)
    except (ValueError, OSError):
        return None
    return raw


@app.get("/versions")
async def versions(limit: int = 50):
    try:
        notes = _versions_store().list_notes(_clamp_limit(limit))
        root = vault_core.vault_root().resolve()
        out = []
        for note in notes:
            if not isinstance(note, dict):
                continue
            entry = dict(note)
            path = Path(str(note.get("path") or ""))
            try:
                entry["display"] = str(path.resolve().relative_to(root))
            except (ValueError, OSError):
                entry["display"] = path.name  # outside the vault: basename only
            out.append(entry)
        return {"notes": out}
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return {"notes": []}


@app.get("/versions/list")
async def versions_list(path: str = ""):
    try:
        note_path = _vault_note_path(path)
        if note_path is None:
            return {"path": "", "versions": []}
        return {
            "path": note_path,
            "versions": _versions_store().list_versions(note_path),
        }
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return {"path": "", "versions": []}


@app.get("/versions/content")
async def versions_content(path: str = "", id: str = ""):
    try:
        note_path = _vault_note_path(path)
        if note_path is None or not _VERSION_ID_RE.fullmatch(id):
            return {"content": None}
        return {"content": _versions_store().read_version(note_path, id)}
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return {"content": None}


class VersionsRestoreRequest(BaseModel):
    path: str = ""
    id: str = ""


@app.post("/versions/restore")
async def versions_restore(req: VersionsRestoreRequest):
    """Write a captured version back over its note. Token-gated (POST).

    {"ok": bool} on every outcome, never a 500. The pre-checks here refuse
    obvious junk without touching the store; restore() itself re-validates
    containment + Sources/ and captures the current content first, so a
    restore is always itself undoable.
    """
    try:
        note_path = _vault_note_path(req.path)
        if note_path is None or not _VERSION_ID_RE.fullmatch(req.id):
            return {"ok": False}
        return {"ok": bool(_versions_store().restore(note_path, req.id))}
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return {"ok": False}


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

    The reset lives in a ``finally`` keyed off ``completed_cleanly`` rather
    than the old ``except Exception`` + ``failed`` flag: a client that
    disconnects MID-turn makes the SDK stream raise asyncio.CancelledError
    or GeneratorExit, both BaseException — neither is caught by
    ``except Exception``, so ``failed`` never flipped and the reset never
    ran. Left unreset, the long-lived client keeps that turn's unconsumed
    ResultMessage buffered and the NEXT turn reads it instead of its own
    reply, so every reply ends up permanently one turn behind. The finally
    below resets on ANY exit that is not the normal completion, including
    those BaseExceptions, and never swallows them — they propagate right
    after the reset runs.
    """
    completed_cleanly = False
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
            completed_cleanly = True
    except Exception as exc:  # noqa: BLE001 - surface as an SSE error event
        yield _sse(
            {
                "done": True,
                "error": True,
                "response": (
                    f"Atelier hit an error and could not finish that turn: {exc}"
                ),
            }
        )
    finally:
        if not completed_cleanly:
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


# --- Mini-app generator (POST /miniapp) -----------------------------------------
#
# One-shot generation of a self-contained HTML mini-app for the desktop app's
# Mini-app card. Every request runs on a FRESH ClaudeSDKClient (never the
# long-lived chat client, so a build cannot pollute the user's chat context)
# with a purpose-built options variant: the MINIAPP system prompt, no tools at
# all, and a tight turn cap — the generator only ever writes one document.

MINIAPP_INSTRUCTIONS = """You build tiny self-contained web apps.

Produce exactly ONE complete self-contained HTML document implementing the small app the user describes.

Rules:
- Inline CSS and JS only. No external resources of any kind: no http(s) fetches, no script/link/img src pointing at the network, no CDN imports.
- No forms that post anywhere.
- Default aesthetic unless the user asks otherwise: warm cream background #faf7f1, ink text #3c3022, terracotta accent #c05c37.
- Reply with ONLY the HTML document, nothing before or after it."""


def _miniapp_options() -> ClaudeAgentOptions:
    """build_options() variant for the mini-app generator.

    Same model + provider + isolation env as every other run, but the MINIAPP
    system prompt, no tools (allowed_tools=[] / mcp_servers={}), and
    max_turns=4. dataclasses.replace on the FRESH instance build_options()
    returns per call, so the shared builder's behavior for every other caller
    is untouched.
    """
    return dataclasses.replace(
        build_options(),
        system_prompt=MINIAPP_INSTRUCTIONS,
        max_turns=4,
        allowed_tools=[],
        mcp_servers={},
    )


# The first fenced html code block in a reply. DOTALL so the document's
# newlines stay inside the one match; IGNORECASE for a "```HTML" fence.
_MINIAPP_FENCE_RE = re.compile(r"```html[ \t]*\n(.*?)```", re.DOTALL | re.IGNORECASE)

# Ceiling on the extracted document, matching the desktop card's contract; a
# document past this is rejected rather than truncated (a truncated app would
# render broken and look like a model bug).
_MINIAPP_MAX_CHARS = 300_000


def _extract_miniapp_html(text: str) -> str | None:
    """The reply's HTML document, or None when there is nothing usable.

    Extraction order per the contract: the first fenced html code block, else
    the raw reply when it starts (after whitespace) with <!doctype or <html.
    """
    match = _MINIAPP_FENCE_RE.search(text)
    if match:
        return match.group(1).strip() or None
    stripped = text.strip()
    if stripped.lower().startswith(("<!doctype", "<html")):
        return stripped
    return None


class MiniappRequest(BaseModel):
    # min 3 rejects junk pokes; max 2000 bounds the prompt the model sees.
    description: str = Field(min_length=3, max_length=2000)


@app.post("/miniapp")
async def miniapp(req: MiniappRequest):
    """Generate one self-contained mini-app HTML document. Token-gated (POST).

    {"html": str} on success, {"error": str} on every failure mode — a failed
    or unusable run never 500s the card.
    """
    try:
        async with ClaudeSDKClient(options=_miniapp_options()) as client:
            await client.query(req.description)
            result = await _collect_response(client)
    except Exception as exc:  # noqa: BLE001 - never 500 the card
        return {"error": f"mini-app generation failed: {exc}"}
    if result.get("error"):
        return {"error": result["response"]}
    html = _extract_miniapp_html(result["response"])
    if html is None:
        return {"error": "the model did not return a usable HTML document"}
    if len(html) > _MINIAPP_MAX_CHARS:
        return {"error": "generated app too large"}
    return {"html": html}


# --- Multi-card agent sessions ------------------------------------------------
#
# Each Agent card in the desktop app owns ONE of these sessions: a fresh
# conversation on its own ClaudeSDKClient (same build_options() isolation as
# /chat and the compat route, but a separate client from BOTH — a card can
# never pollute the main chat context or a scheduled job's).
#
# Shape (fixed contract with app/sessions.js + tests):
#   POST   /sessions                {"name"?}    -> {"id","name"}
#   GET    /sessions                             -> {"sessions":[{id,name,status,messages_len,parent_id,depth}]}
#   GET    /sessions/{id}                        -> {id,name,status,messages:[{role,text,ts}],parent_id,depth,browser_nav}
#   (browser_nav rides ONLY on the detail route the card polls, never the list)
#   POST   /sessions/{id}/message   {"message"}  -> 202 {"status":"running"} (fire-and-poll)
#   DELETE /sessions/{id}                        -> {"ok":true}
#   unknown id -> 404 {"error":"unknown session"}; a turn error sets
#   status "error" + an assistant message carrying the error text — never a 500.
#
# ponytail: in-memory sessions; disk persistence is the upgrade.


class _AgentSession:
    """One card-scoped conversation: lazy client + status + message ledger.

    ``parent_id``/``depth`` mark sub-agent sessions: a card session is depth 0
    with no parent; a session spawned by SpawnAgent is depth 1 with parent_id
    pointing at its spawner. Depth never exceeds 1 (see _run_session_turn).

    ``browser_nav`` is the latest NavigateBrowser request against this session
    ({"url", "seq"}, seq strictly increasing) or None; the desktop card polls
    it off GET /sessions/{id} and acts when seq advances past what it has seen.
    """

    def __init__(
        self,
        session_id: str,
        name: str,
        parent_id: str | None = None,
        depth: int = 0,
    ):
        self.id = session_id
        self.name = name
        self.parent_id = parent_id
        self.depth = depth
        self.model: str | None = None  # per-session model override; None -> _resolved_model()
        # A model change POSTed while this session is mid-turn cannot touch the
        # client the running turn is already using; this flag tells the turn's
        # finally block to drop that client once it settles, so the NEXT turn
        # rebuilds fresh and actually picks up the new model.
        self.pending_model_reset: bool = False
        self.client: ClaudeSDKClient | None = None  # lazy: built on first message
        self.lock = asyncio.Lock()
        self.status = "idle"  # "idle" | "running" | "error"
        self.messages: list[dict] = []  # {"role","text","ts"} append-only
        self.browser_nav: dict | None = None  # latest NavigateBrowser request
        self.last_used = next(_session_touch)


_sessions: dict[str, _AgentSession] = {}
_session_seq = itertools.count(1)    # 'Agent N' default names
_session_touch = itertools.count(1)  # deterministic LRU clock (no wall-time ties)
# Strong refs to in-flight turn tasks; asyncio only holds weak ones.
_session_tasks: set = set()


def _max_sessions() -> int:
    """The session cap, read from env at call time so tests can tune it.

    12 (was 6): each depth-0 card can hold up to 4 live sub-agents, so the
    old cap would starve spawning with just two busy cards.
    """
    try:
        return max(1, int(os.getenv("ATELIER_MAX_SESSIONS", "12")))
    except ValueError:
        return 12


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


async def _make_room() -> bool:
    """Evict idle/error LRU sessions until the cap has room; False = all running.

    Shared by create_session (a new card) and SpawnAgent (a new sub-agent):
    evictable = any session NOT mid-turn ("idle" or "error" — an errored card
    is just as reclaimable).
    """
    while len(_sessions) >= _max_sessions():
        evictable = [s for s in _sessions.values() if s.status != "running"]
        if not evictable:
            return False
        victim = min(evictable, key=lambda s: s.last_used)
        _sessions.pop(victim.id, None)
        await _close_session_client(victim)
    return True


async def _spawn_session_turn(coro) -> None:
    """Fire-and-forget one turn. Tests monkeypatch this to await inline."""
    task = asyncio.create_task(coro)
    _session_tasks.add(task)
    task.add_done_callback(_session_tasks.discard)


async def _start_turn(sess: _AgentSession, message: str) -> None:
    """Kick off one fire-and-poll turn (shared by session_message + SpawnAgent):
    append the user message, mark running, touch the LRU clock, spawn the task.
    Callers gate on status/ledger BEFORE calling this."""
    _append_session_message(sess, "user", message)
    sess.status = "running"
    _touch_session(sess)
    await _spawn_session_turn(_run_session_turn(sess, message))


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
                # ONLY depth-0 (card-level) sessions get the spawn orchestra
                # (Spawn/Check/Nav), so the spawn depth cap is structural rather
                # than an instruction the model could talk itself past. EVERY
                # session passes its own id as delegator so any session that
                # governs children also gains DelegateToSubagent (build_options
                # gates that on there actually being children).
                client = ClaudeSDKClient(
                    options=build_options(
                        spawner_session_id=sess.id if sess.depth == 0 else None,
                        delegator_session_id=sess.id,
                        model=sess.model,
                    )
                )
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
            # A model change landed mid-turn (set_session_model's running
            # branch): the client this turn just used is now stale, so drop it
            # here — the next turn's `sess.client is None` check rebuilds on
            # the new model instead of silently reusing the old one.
            if sess.pending_model_reset:
                sess.pending_model_reset = False
                await _close_session_client(sess)
            # Deleted MID-turn: delete_session's disconnect may have raced our
            # lazy connect above, leaving a live client on the detached object.
            if _sessions.get(sess.id) is not sess:
                await _close_session_client(sess)


class SessionCreateRequest(BaseModel):
    name: str | None = None
    model: str | None = None


class SessionMessageRequest(BaseModel):
    # ponytail: 200k-char ceiling — far past any real prompt, small enough that
    # a hostile local client cannot balloon resident memory one POST at a time.
    message: str = Field(max_length=200_000)


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


@app.get("/sessions")
async def list_sessions():
    return {
        "sessions": [
            {
                "id": s.id,
                "name": s.name,
                "status": s.status,
                "messages_len": len(s.messages),
                "parent_id": s.parent_id,
                "depth": s.depth,
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
        "parent_id": sess.parent_id,
        "depth": sess.depth,
        "model": sess.model,
        "browser_nav": sess.browser_nav,
    }


@app.post("/sessions/{session_id}/model")
async def set_session_model(session_id: str, req: ModelRequest):
    """Set this session's model override (same allowlist as POST /config/model).

    Resolution at turn time is (session.model or _resolved_model()). Dropping
    the lazily-built client while idle makes the change take effect on the next
    turn; a fresh card has no client yet (no-op). A RUNNING turn cannot have
    its in-flight client swapped out from under it, so instead this sets
    sess.pending_model_reset — _run_session_turn's finally block drops the
    client once the current turn settles, so the NEXT turn rebuilds on the
    new model rather than silently reusing the old one.
    """
    sess = _sessions.get(session_id)
    if sess is None:
        return _unknown_session()
    if req.model not in _ALLOWED_MODELS:
        return JSONResponse({"error": "unknown model"}, status_code=400)
    sess.model = req.model
    if sess.status != "running":
        await _close_session_client(sess)
    else:
        sess.pending_model_reset = True
    return {"ok": True, "model": sess.model}


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
    await _start_turn(sess, req.message)
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


@app.delete("/sessions/{session_id}/govern/{child_id}")
async def ungovern_session(session_id: str, child_id: str):
    """Clear a governed child's parent_id/depth — but only if session_id is
    actually the child's current parent (idempotent either way).

    session_id is the orchestrator the arrow was drawn from; the clear only
    applies when child.parent_id == session_id, so a DELETE against a stale
    or wrong parent (e.g. a re-governed child whose old parent's UI hasn't
    caught up) can never detach the child from its REAL current parent. A
    DELETE against a link that no longer exists (mismatched parent, or the
    child was never governed) is not an error — it just returns {"ok": true}
    without touching the child. Unknown child -> 404 {"error": "unknown
    session"} (the existing /sessions idiom).
    """
    child = _sessions.get(child_id)
    if child is None:
        return _unknown_session()
    if child.parent_id == session_id:
        child.parent_id = None
        child.depth = 0
    return {"ok": True}


# --- Sub-agent orchestration (the "orchestra" MCP server) -----------------------
#
# Each depth-0 session's client gets its OWN in-process orchestra server whose
# tools close over that session's id (see build_options). A spawned child
# is just another _AgentSession — same isolation, same /sessions surface, so
# the desktop app can reveal it as a card — with parent_id/depth marking the
# relationship. Tool results are plain text: the model reads them, and the
# text convention mirrors shared_tools/sdk_tools.py's wrap_tool.
#
# NavigateBrowser is the third tool: the agent requests navigation of the
# browser card the USER linked to its card (no CDP, no autonomous browsing —
# the request is just a {"url","seq"} field the card polls and acts on, so
# every navigation is user-visible and user-sanctioned via the link).

_subagent_seq = itertools.count(1)  # 'Sub-agent N' default names
_MAX_CHILDREN = 4  # live children per parent; keeps one card from eating the cap

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

# Module-wide monotonic counter for browser_nav requests: the poller compares
# seq against the last one it acted on, so repeats of the SAME url still fire.
_browser_nav_seq = itertools.count(1)

_HTTP_URL_RE = re.compile(r"^https?://")


def _tool_text(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def _orchestra_tools(parent_id: str) -> list:
    """The SpawnAgent/CheckAgent/NavigateBrowser SdkMcpTools, closed over the
    spawner's id.

    Factored from _build_orchestra_server so tests can invoke the handlers
    directly (the SDK server config does not expose them back) and so
    GET /tools can introspect the declared names/descriptions/schemas.
    """

    @tool(
        "SpawnAgent",
        "Spawn a parallel sub-agent session to delegate a subtask. The"
        " sub-agent starts working on the task immediately in its own isolated"
        " session; use CheckAgent with the returned id to collect its result.",
        {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "The subtask for the sub-agent to work on,"
                    " written as a complete standalone instruction.",
                },
                "name": {
                    "type": "string",
                    "description": "Optional short display name for the"
                    " sub-agent.",
                },
            },
            "required": ["task"],
        },
    )
    async def _spawn_agent(args):
        if parent_id not in _sessions:
            # The spawner was deleted/evicted mid-turn; its child would be
            # orphaned before it started.
            return _tool_text("Your session is gone; cannot spawn.")
        children = [
            s for s in _sessions.values() if s.parent_id == parent_id
        ]
        if len(children) >= _MAX_CHILDREN:
            return _tool_text(
                f"Child limit ({_MAX_CHILDREN}) reached — use CheckAgent on"
                " your existing sub-agents instead."
            )
        # The parent is mid-turn ("running"), so _make_room can never evict it.
        if not await _make_room():
            return _tool_text(
                "Session limit reached — no room for a sub-agent right now."
            )
        # Re-check after _make_room: it can suspend awaiting a victim's
        # disconnect, and a DELETE of the parent landing in that window would
        # otherwise register an orphan child (no card, no reachable
        # CheckAgent) that burns a full turn before LRU eviction finds it.
        if parent_id not in _sessions:
            return _tool_text("Your session is gone; cannot spawn.")
        name = (args.get("name") or "").strip() or f"Sub-agent {next(_subagent_seq)}"
        child = _AgentSession(
            uuid.uuid4().hex, name, parent_id=parent_id, depth=1
        )
        _sessions[child.id] = child
        await _start_turn(child, args["task"])
        return _tool_text(
            f'Spawned sub-agent "{child.name}" (id: {child.id}). It is working'
            " now; call CheckAgent with this id to collect its result."
        )

    @tool(
        "CheckAgent",
        "Check a sub-agent's status and result. Pass the id returned by"
        " SpawnAgent; when the sub-agent has finished, its last reply is"
        " returned.",
        {
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": "The sub-agent session id from SpawnAgent.",
                },
            },
            "required": ["agent_id"],
        },
    )
    async def _check_agent(args):
        child = _sessions.get(args.get("agent_id") or "")
        # A live session that is NOT this parent's child (another card, or a
        # sibling parent's sub-agent) is treated as unknown: one card's model
        # must never read another conversation through this tool.
        if child is None or child.parent_id != parent_id:
            return _tool_text("No such sub-agent session.")
        if child.status == "running":
            return _tool_text(
                f'Sub-agent "{child.name}" ({child.id}) is still working'
                f" ({len(child.messages)} messages so far)."
            )
        last_reply = next(
            (
                m["text"]
                for m in reversed(child.messages)
                if m["role"] == "assistant"
            ),
            "(no reply)",
        )
        finished = (
            "finished with an error" if child.status == "error" else "finished"
        )
        return _tool_text(
            f'Sub-agent "{child.name}" {finished}. Last reply: {last_reply}'
        )

    @tool(
        "NavigateBrowser",
        "Open an http(s) URL in the browser card the user has linked to this"
        " conversation. This only works when the user has linked a browser"
        " card (by shift-dragging a selection box around a browser card and"
        " this agent card); if none is linked, nothing opens and you should"
        " ask the user to link one.",
        {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The http(s) URL to open in the linked"
                    " browser card.",
                },
            },
            "required": ["url"],
        },
    )
    async def _navigate_browser(args):
        url = str(args.get("url") or "")
        if not _HTTP_URL_RE.match(url):
            return _tool_text("Only http(s) URLs can be opened.")
        parent = _sessions.get(parent_id)
        if parent is None:
            # The spawner was deleted/evicted mid-turn; there is no session
            # for the card to poll, so the request has nowhere to land.
            return _tool_text("Your session is gone; cannot navigate.")
        parent.browser_nav = {"url": url, "seq": next(_browser_nav_seq)}
        return _tool_text(
            f"Navigation requested — {url} will load in the browser card the"
            " user linked to this conversation (if none is linked, ask the"
            " user to shift-drag a box around a browser card and this card)."
        )

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

    return [_spawn_agent, _check_agent, _navigate_browser, _delegate_agent]


def _build_orchestra_server(parent_id: str):
    """One per-call orchestra server bound to the spawning session's id."""
    return create_sdk_mcp_server(
        name="orchestra", version="1.0.0", tools=_orchestra_tools(parent_id)
    )


# --- Tool inspector endpoint (GET /tools) ----------------------------------------
#
# Read-only registry of every tool the backend can hand a model, for the
# desktop app's tool-inspector card. The atelier entries are introspected from
# the LIGHT_TOOLS classes with the SAME schema builder sdk_tools uses to
# register them, so what the inspector shows can never drift from what the
# model sees; the orchestra entries come off the SdkMcpTool objects the @tool
# decorators declare. Same conventions as the dashboard endpoints: fixed
# shape, never 500, no token (read-only GET).


@app.get("/tools")
async def tools_registry():
    try:
        entries = [
            {
                "name": cls.__name__,
                "description": (cls.__doc__ or cls.__name__).strip(),
                "input_schema": sdk_tools._build_input_schema(cls),
                "server": "atelier",
                "availability": "all sessions",
            }
            for cls in LIGHT_TOOLS
        ]
        # Bound to a probe id: only the declared metadata is read here; the
        # handler closures are never invoked.
        entries += [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
                "server": "orchestra",
                "availability": "agent cards (depth 0)",
            }
            for t in _orchestra_tools("__tools_probe__")
        ]
        return {"tools": entries}
    except Exception:  # noqa: BLE001 - never 500; degrade to the empty shape
        return {"tools": []}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.getenv("PORT", "8765")),
        log_level="warning",
    )
