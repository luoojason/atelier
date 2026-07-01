# Atelier

<img src="assets/atelier_512.png" width="112" align="right" alt="Atelier"/>

**Atelier** is a studio of AI specialists that composes research, documents,
slides, images, and video into **gated, published deliverables** — running
entirely on your **Claude Max subscription** (zero API keys).

A fork of [OpenSwarm](https://github.com/VRSEN/OpenSwarm) (Agency Swarm),
extended into a general-purpose deliverable workforce. A Campaign meta-agent
decomposes a goal, delegates to specialists, gates each result through a Critic,
and publishes only what passes.

## Run it on your subscription

```sh
# in .env — leave OPENAI_API_KEY / ANTHROPIC_API_KEY blank
DEFAULT_MODEL=claude-cli        # or CLAUDE_SUBSCRIPTION=1

python server.py                # FastAPI on :8080   (or: python swarm.py for the TUI)
```

Needs the `claude` CLI logged into Claude Max. Full guide: [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Inside
- **Subscription backend** (`claude -p`) — zero API keys, zero per-token billing
- **Knowledge + memory** — live vault search/read/write, persistent memory, structured Briefs
- **Publisher** (YouTube upload + scheduled publish, vault) and **Scheduler** (run ledger, retries, failure notifications, overnight digest)
- **Critic** QA gate + **Campaign** meta-agent (generate → gate → publish → log)
- ~200 tests; hardened by a 28-bug adversarial debug

Icon and name are the fork's own; the app engine upstream remains VRSEN's.
