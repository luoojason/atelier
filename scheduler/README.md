# OpenSwarm Scheduler

An always-on process that fires prompts at the OpenSwarm agency on a cadence, so
the workforce runs unattended. It talks to the same FastAPI server that
`server.py` starts (`run_fastapi(agencies={"open-swarm": create_agency}, port=8080)`).

## What it hits

Determined by inspecting the installed `agency_swarm.integrations.fastapi`
server:

- **Route:** `POST {base_url}/{agency}/get_response` (the agency name has spaces
  replaced with underscores; `open-swarm` stays `open-swarm`).
- **Body:** `{"message": "<prompt>", "recipient_agent": "<agent>"}`
  (`recipient_agent` is omitted when a job has no `agent`).
- **Auth:** `Authorization: Bearer <APP_TOKEN>` — only required when the server
  was started with an `APP_TOKEN` env var. If the server has no token, leave the
  scheduler's token unset and no auth header is sent.
- **Response:** `{"response": <final_output>, "new_messages": [...], "usage": {...}}`.

## Files

| File | Purpose |
|------|---------|
| `jobs_core.py` | Pure logic: parse/validate jobs, `parse_interval`, `build_trigger`, run-log formatting. No framework deps. |
| `client.py` | `build_request` (pure) + `send` (thin httpx POST, injectable client). |
| `scheduler.py` | The daemon: loads jobs, registers them with APScheduler, fires them, logs to `runs.log`. |
| `jobs.example.yaml` | Two sample jobs (one cron, one interval). Copy to `jobs.yaml`. |
| `runs.log` | Append-only run log (created on first run). Doubles as the durable "what happened" memory across restarts. |

## Configure the jobs

Copy the example and edit:

```bash
cp scheduler/jobs.example.yaml scheduler/jobs.yaml
```

Each list item:

```yaml
- name: morning-standup
  schedule: "0 9 * * *"     # cron (5 or 6 fields) OR an interval: 30s / 30m / 2h / 1d
  prompt: "Summarize yesterday's logs and list today's top 3 priorities."
  agent: orchestrator        # optional recipient agent
  endpoint: http://localhost:8080   # optional per-job base-URL override
```

The cron `weekday` field uses standard Unix numbering — `0` or `7` is Sunday,
`1` is Monday … `6` is Saturday (weekday names `mon`–`sun` work too). Invalid
field contents (out-of-range numbers, bad names) are rejected per-job with a
clear error rather than aborting the daemon.

## Run it standalone

The daemon needs `apscheduler`, `httpx`, and (ideally) `pyyaml`. The test venv
already has them:

```bash
# 1. start the agency server in one shell
python server.py            # serves http://localhost:8080

# 2. start the scheduler in another shell
/Users/jasonluo08/Desktop/openswarm/.venv-ext/bin/python scheduler/scheduler.py
```

Environment knobs:

| Var | Default | Meaning |
|-----|---------|---------|
| `SWARM_JOBS_FILE` | `scheduler/jobs.yaml` (falls back to `jobs.example.yaml`) | Jobs YAML path |
| `SWARM_BASE_URL` | `http://localhost:8080` | Agency base URL |
| `SWARM_AGENCY` | `open-swarm` | Agency name / route segment |
| `SWARM_APP_TOKEN` | (falls back to `APP_TOKEN`) | Bearer token, if the server requires one |
| `SWARM_RUNS_LOG` | `scheduler/runs.log` | Append-only run log path |

`Ctrl-C` / `SIGTERM` shuts the scheduler down cleanly and records a `stop` line
in `runs.log`.

## Prefer to reuse an existing scheduler?

You do **not** have to run this as a second daemon. Everything real lives in
`client.py`, so you can trigger the same POST from any scheduler you already run:

- **Iris** (`claude -p`) or any agent loop can call
  `scheduler.client.send(base_url, "open-swarm", prompt, agent=...)` directly.
- **launchd / cron** can shell out to a one-liner:

  ```bash
  /path/to/.venv-ext/bin/python -c \
    "from scheduler.client import send; print(send('http://localhost:8080','open-swarm','your prompt'))"
  ```

  Wrap that in a `launchd` `.plist` with a `StartCalendarInterval` and you get
  the same cadence without a long-lived Python process.

Use whichever fits: the standalone daemon for many jobs in one place, or a
`client.send` call wired into an existing scheduler for a single recurring task.

> TODO: the route/payload above were verified against the currently installed
> `agency-swarm` in `.venv-ext`. If you upgrade `agency-swarm` and the server's
> route or body shape changes, update `RESPONSE_ROUTE`/`build_request` in
> `client.py` (or override per-job via `endpoint` + a future body-shape config).
