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

import os

# Must be set before importing config so the subscription backend is selected.
os.environ.setdefault("DEFAULT_MODEL", "claude-cli")

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

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
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

# Permissive CORS: the Electron renderer calls this local server directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
