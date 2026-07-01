# OpenSwarm fork — extensions

This fork (`branch swarm-extensions`) turns OpenSwarm from a single-deliverable
generator into a **hardened, gated deliverable workforce that runs on a Claude
subscription**. Everything below was added on top of upstream; nothing upstream
was removed. ~200 unit tests, all green under system `python3` (heavy-runtime
agents import under the full env).

## Run it on your Claude subscription (no API keys)

The headline: set one env var and the whole agency reasons on your Claude Max
login via the sanctioned `claude` CLI (`claude -p`), zero per-token billing.

```
# in .env
DEFAULT_MODEL=claude-cli          # or CLAUDE_SUBSCRIPTION=1 over any DEFAULT_MODEL
# leave OPENAI_API_KEY / ANTHROPIC_API_KEY blank
```

Requires the `claude` CLI installed and logged into Claude Max. `claude-cli:sonnet`
picks a specific model. Any other `DEFAULT_MODEL` (e.g. `gpt-5.4`,
`litellm/claude-...`) keeps the original OpenAI/LiteLLM behavior. Implementation:
`claude_subscription_model.py` implements the openai-agents `Model` interface;
native Claude tools are disabled and agency-swarm's Python tools + handoffs are
bridged via a prompt+JSON tool-call protocol (one tool call per turn; the SDK loop
handles multi-step). Honest limits: non-incremental streaming; one tool call per
turn; the verdict a Campaign records is agent-supplied (see Campaign gate below).

**Service auth is separate from the model.** These are third-party services the
*tools* call, not the LLM, and no subscription covers them (all optional):
YouTube = Google OAuth; Composio = Gmail/Drive/social; Sora/Veo/fal = paid media
gen; search/stock-photo keys. The local tools (scheduler, ledger, brief, critic,
digest, vault, memory, narrated-short) need none.

## What was added

**Knowledge + memory**
- `shared_tools/vault_core.py` + `VaultSearch`/`VaultRead`/`VaultWrite`: live search/
  read/write over the Obsidian vault (`OBSIDIAN_VAULT`). `Sources/` is immutable
  (resolve+containment, case-folded); `VaultRead` is contained to `.md` in the vault.
  Writes catalog themselves: append a dated `log.md` line + idempotent `index.md`
  row upsert (`catalog=True`), pipe/`]]`-escaped, wikilink from the sanitized filename.
- `shared_tools/memory_core.py` + `RememberFact`/`RecallMemory`: persistent store
  (`SWARM_MEMORY_PATH`). fcntl-locked, atomic, and corruption-preserving (a partial
  write is quarantined, never wipes history).
- `shared_tools/brief_core.py` + `CaptureBrief`/`ReadBrief`: a structured Brief
  (goal + acceptance criteria) per project — the precondition for the Critic gate.

**Publishing**
- `publisher_agent/`: a delivery specialist. `UploadToYouTube` (real Data API,
  `publish_at` for native scheduled publish), `PublishToVault` (injection-safe),
  `RenderAndUploadShort` (render→upload one-shot). Email/Drive/social route to the
  General Agent via Composio.

**Always-on + observability**
- `scheduler/`: an APScheduler daemon firing prompts at the agency FastAPI on
  cron/interval (`scheduler/jobs.yaml`); or drive `scheduler.client.send(...)` from
  Iris/launchd. Per-job cron validation, phase-aware retries (connect-phase only, so
  a long upload can't double-fire), a rotating JSONL run ledger (`runs.jsonl`),
  failure notifications (durable + optional AIEOS event, dedup'd), and an overnight
  digest to the vault. All fcntl-locked / robust to malformed input.
- AIEOS integration (in `~/cc-dashboard-app`): `aimd/os_activity/swarm_runs.py`
  surfaces the ledger in the OS Activity panel beside Claude sessions.

**Quality + composition**
- `critic_agent/`: review-only. Scores a deliverable against the Brief; the verdict
  is a deterministic gate (`verdict_from_scores`) that requires full rubric coverage
  and cannot be shipped by fiat; fail-safe to `block`.
- `campaign_agent/`: the meta-agent. Decomposes a goal into deliverables, delegates
  each to a specialist, gates each through the Critic, and lets only a `ship`
  deliverable reach the Publisher. `ready_to_publish()` is code, not agent discretion;
  a new path swapped in after `ship` invalidates the stale verdict.
- Narrated shorts: `video_generation_agent/tools/RenderShortFrom*` reuse the local
  reddit-shorts pipeline (`REDDIT_SHORTS_PATH`) for captioned 9:16 shorts.

## Running

- **Interactive agency:** `python swarm.py` (TUI) or `python server.py` (FastAPI :8080).
- **A gated campaign:** ask the Campaign Agent, e.g. "Run a campaign: research X,
  then a deck and a short, review each, publish what passes."
- **Unattended:** copy `scheduler/jobs.example.yaml` → `jobs.yaml`, then
  `python scheduler/scheduler.py` (or trigger from Iris).

## Backlog

`BACKLOG.md` holds the full 43-item research backlog. Items #1–#12 + the
subscription backend + the Campaign agent are built. The remainder is the
deliberately down-ranked tier (browser-based TikTok/Instagram/X posting, HITL
park-and-resume) — API-gated, human-tap-gated, or pay-per-use, and poor for
unattended reliability.
