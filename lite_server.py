"""Lite subscription backend for Atelier.

A single-file FastAPI app that serves ONE "Atelier" agent on the user's Claude
Max subscription (via config.get_default_model() with DEFAULT_MODEL=claude-cli),
carrying only the LIGHT tools that import cleanly without the heavy media deps
(weasyprint / playwright / moviepy / jupyter / google-genai). It deliberately
does NOT import swarm.create_agency or any of the heavy specialist agents.

Run:
    DEFAULT_MODEL=claude-cli PORT=8765 \
        /Users/jasonluo08/Desktop/openswarm/.venv-ext/bin/python lite_server.py
"""

import datetime
import json
import os
import re
from pathlib import Path

# Must be set before importing config so the subscription backend is selected.
os.environ.setdefault("DEFAULT_MODEL", "claude-cli")
# The app backend defaults to isolated `claude -p` runs (safe-mode + private
# config dir; see claude_subscription_model.run_cli). The raw fork stays opt-in.
os.environ.setdefault("CLAUDE_ISOLATED", "1")

import config

# Disable OpenAI tracing when there is no OpenAI key, so building/running the
# agent on the subscription never trips over a missing tracing export key.
try:  # pragma: no cover - defensive; tracing is optional
    from agents import set_tracing_disabled

    if not os.getenv("OPENAI_API_KEY"):
        set_tracing_disabled(True)
except Exception:  # noqa: BLE001
    pass

import agency_swarm

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
from campaign_agent.tools.StartCampaign import StartCampaign
from campaign_agent.tools.RecordDeliverable import RecordDeliverable
from campaign_agent.tools.CampaignStatus import CampaignStatus

# Pure stdlib scheduler helpers backing the read-only dashboard endpoints.
from scheduler import jobs_core, run_store
from scheduler import notify as swarm_notify

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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

# --- Build ONE agent on the subscription and wrap it in a single Agency. ---
agent = agency_swarm.Agent(
    name="Atelier",
    instructions=ATELIER_INSTRUCTIONS,
    model=config.get_default_model(),
    tools=LIGHT_TOOLS,
)

# Module-level agency, reused across every /chat call so the conversation keeps
# continuity (memory of prior turns) within the process.
agency = agency_swarm.Agency(agent, name="Atelier")


app = FastAPI(title="Atelier Lite")

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


@app.get("/health")
async def health():
    backend = config.get_default_model()
    model_name = type(backend).__name__
    return {
        "ok": True,
        "model": model_name,
        "subscription": not config.is_openai_provider(),
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
    try:
        # get_response_sync is blocking/sync; run it off the event loop so the
        # server stays responsive. Reuse the single module-level agency.
        result = await run_in_threadpool(agency.get_response_sync, req.message)
        text = getattr(result, "final_output", None)
        if text is None:
            text = str(result)
        return {"response": str(text)}
    except Exception as exc:  # noqa: BLE001 - never 500 the UI
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
