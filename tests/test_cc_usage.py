"""Tests for lite_server's /config + /cc/* Claude Code usage endpoints via
fastapi TestClient — no live server, no network. CLAUDE_PROJECTS_DIR is
pointed into tmp_path fixtures: two synthetic transcripts whose line shapes
mirror the real CLI (v2.1.x) — including the modern lines that carry BOTH the
legacy cache_creation_input_tokens total AND the granular cache_creation
block, the exact double-count trap the parser must not fall into.

Needs the extension venv (lite_server imports claude_agent_sdk + tools):

    .venv-ext/bin/python -m pytest -q tests/test_cc_usage.py
"""

import datetime
import json
import os
import sys
import time

import pytest

# UNCONDITIONAL insert at position 0 (mirrors test_claude_subscription.py):
# test_campaign.py — collected just before this module — puts campaign_agent/
# itself at sys.path[0], where campaign_agent/campaign_agent.py shadows the
# real package and would break lite_server's `from campaign_agent.tools ...`.
# Re-fronting the repo root keeps the real package first.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

# Pricing (USD per MTok) used in the hand-computed expectations below:
SONNET = "claude-sonnet-4-5-20250929"  # 3.0 in / 15.0 out / 3.75 cw5m / 6.0 cw1h / 0.30 cr
HAIKU = "claude-haiku-4-5"             # 1.0 in /  5.0 out / 1.25 cw5m / 2.0 cw1h / 0.10 cr

SESSION_A = "aaaa1111-2222-4333-8444-555566667777"
SESSION_B = "bbbb2222-3333-4444-8555-666677778888"

# Session A (sonnet):
#   turn1: 100 in + 200 out + 1000 cw5m
#     usd = 100*3/1e6 + 200*15/1e6 + 1000*3.75/1e6 = 0.00705 ; tokens = 1300
#   turn2: 50 in + 100 out + 500 cw1h + 1000 cr — the legacy total (500) is
#     ALSO present on the line and must be counted ONCE
#     usd = 0.00015 + 0.0015 + 500*6/1e6 + 1000*0.3/1e6 = 0.00495 ; tokens = 1650
A_USD = 0.012
A_TOKENS = 2950
# Session B (haiku, legacy-only cache shape): 10 in + 20 out + 200 legacy cw (5m)
#   usd = 0.00001 + 0.0001 + 200*1.25/1e6 = 0.00036 ; tokens = 230
B_USD = 0.00036
B_TOKENS = 230

# (ts index, usd, tokens) per assistant turn, for window-dependent expectations.
TURNS = [(0, 0.00705, 1300), (1, 0.00495, 1650), (2, B_USD, B_TOKENS)]

EMPTY_DETAIL = {
    "session_id": "",
    "totals": {"usd": 0.0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
    "by_model": [],
    "timeline": [],
}


@pytest.fixture(autouse=True)
def _isolate_projects_dir(monkeypatch, tmp_path):
    """Every test starts pointed at a MISSING projects dir — never the real one."""
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(tmp_path / "no-projects"))


@pytest.fixture
def client():
    return TestClient(lite_server.app)


def _ts(minutes_ago):
    dt = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        minutes=minutes_ago
    )
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _local_dt(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()


def _user_line(session_id, ts):
    return {
        "parentUuid": None, "isSidechain": False, "type": "user",
        "message": {"role": "user", "content": "do the thing"},
        "uuid": "user-" + ts, "timestamp": ts, "sessionId": session_id,
        "version": "2.1.195", "userType": "external", "entrypoint": "cli",
        "cwd": "/Users/jasonluo08/Desktop/projA", "gitBranch": "main",
    }


def _assistant_line(session_id, model, ts, *, input_tokens, output_tokens,
                    cache_5m=0, cache_1h=0, cache_read=0, granular=True):
    """One 'assistant' transcript line in the real CLI shape.

    granular=True mirrors the modern CLI: BOTH the legacy
    cache_creation_input_tokens total AND the granular cache_creation block
    are present. granular=False emits the legacy-only shape of old transcripts.
    """
    usage = {
        "input_tokens": input_tokens,
        "cache_creation_input_tokens": cache_5m + cache_1h,
        "cache_read_input_tokens": cache_read,
        "output_tokens": output_tokens,
        "service_tier": "standard",
    }
    if granular:
        usage["cache_creation"] = {
            "ephemeral_5m_input_tokens": cache_5m,
            "ephemeral_1h_input_tokens": cache_1h,
        }
    return {
        "parentUuid": "00000000", "isSidechain": False, "type": "assistant",
        "message": {
            "role": "assistant", "type": "message", "model": model,
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn", "usage": usage,
        },
        "uuid": "asst-" + ts, "timestamp": ts, "sessionId": session_id,
        "version": "2.1.195", "userType": "external", "entrypoint": "cli",
        "cwd": "/Users/jasonluo08/Desktop/projA", "gitBranch": "main",
        "requestId": "req_1",
    }


def _write_jsonl(path, lines, trailer=None):
    with open(path, "w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line) + "\n")
        if trailer is not None:
            fh.write(trailer)


@pytest.fixture
def seeded(monkeypatch, tmp_path):
    """Two projects, two sessions; B is the most recently written transcript."""
    root = tmp_path / "projects"
    proj_a = root / "-Users-jasonluo08-Desktop-projA"
    proj_b = root / "-Users-jasonluo08-Desktop-projB"
    proj_a.mkdir(parents=True)
    proj_b.mkdir(parents=True)
    ts1, ts2, ts3 = _ts(3), _ts(2), _ts(1)

    a_path = proj_a / f"{SESSION_A}.jsonl"
    _write_jsonl(
        a_path,
        [
            {"type": "last-prompt", "leafUuid": "leaf-1", "sessionId": SESSION_A},
            _user_line(SESSION_A, ts1),
            _assistant_line(SESSION_A, SONNET, ts1,
                            input_tokens=100, output_tokens=200, cache_5m=1000),
            _assistant_line(SESSION_A, SONNET, ts2,
                            input_tokens=50, output_tokens=100,
                            cache_1h=500, cache_read=1000),
        ],
        trailer="{torn non-json line the parser must skip\n",
    )

    b_path = proj_b / f"{SESSION_B}.jsonl"
    _write_jsonl(
        b_path,
        [
            _user_line(SESSION_B, ts3),
            _assistant_line(SESSION_B, HAIKU, ts3,
                            input_tokens=10, output_tokens=20,
                            cache_5m=200, granular=False),
        ],
    )

    now = time.time()
    os.utime(a_path, (now - 100, now - 100))
    os.utime(b_path, (now - 50, now - 50))  # B most recent
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(root))
    return {"root": root, "ts": (ts1, ts2, ts3)}


# --------------------------------------------------------------------------- #
# /cc/status
# --------------------------------------------------------------------------- #


def test_status_counts(seeded, client):
    resp = client.get("/cc/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["conversations"] == 2
    assert body["projects"] == 2
    assert body["active"] is True  # both transcripts written within 5 minutes
    assert body["storage_mb"] >= 0
    assert body["this_week_tokens"] == A_TOKENS + B_TOKENS
    # Month sum computed from the same ts the fixture wrote (robust across a
    # local month boundary at test time).
    now_local = datetime.datetime.now().astimezone()
    expected_month = sum(
        usd for i, usd, _tok in TURNS
        if _local_dt(seeded["ts"][i]).strftime("%Y-%m") == now_local.strftime("%Y-%m")
    )
    assert body["this_month_usd"] == pytest.approx(round(expected_month, 4))


# --------------------------------------------------------------------------- #
# /cc/usage (list)
# --------------------------------------------------------------------------- #


def test_usage_lists_sessions_with_totals(seeded, client):
    body = client.get("/cc/usage").json()
    assert [s["session_id"] for s in body] == [SESSION_B, SESSION_A]  # mtime desc
    b, a = body
    assert set(a) == {"session_id", "project", "model", "total_tokens",
                      "total_usd", "started_at", "turns"}
    assert a["project"] == "-Users-jasonluo08-Desktop-projA"
    assert a["model"] == SONNET
    assert a["total_tokens"] == A_TOKENS
    assert a["total_usd"] == pytest.approx(A_USD)
    assert a["started_at"] == seeded["ts"][0]
    assert a["turns"] == 2
    assert b["project"] == "-Users-jasonluo08-Desktop-projB"
    assert b["model"] == HAIKU
    assert b["total_tokens"] == B_TOKENS
    assert b["total_usd"] == pytest.approx(B_USD)
    assert b["turns"] == 1


def test_usage_limit(seeded, client):
    body = client.get("/cc/usage?limit=1").json()
    assert [s["session_id"] for s in body] == [SESSION_B]


# --------------------------------------------------------------------------- #
# /cc/usage/{id}
# --------------------------------------------------------------------------- #


def test_usage_detail_totals_and_timeline(seeded, client):
    body = client.get(f"/cc/usage/{SESSION_A}").json()
    assert body["session_id"] == SESSION_A
    # cache_write == 1500 (1000 cw5m + 500 cw1h), NOT 2000: the legacy
    # cache_creation_input_tokens total on turn2 must not be double-counted
    # on top of the granular block.
    assert body["totals"] == {
        "usd": pytest.approx(A_USD),
        "input": 150,
        "output": 300,
        "cache_read": 1000,
        "cache_write": 1500,
    }
    assert body["by_model"] == [
        {"model": SONNET, "tokens": A_TOKENS, "usd": pytest.approx(A_USD)}
    ]
    assert len(body["timeline"]) == 2
    assert body["timeline"][0] == {
        "ts": seeded["ts"][0], "tokens": 1300, "usd": pytest.approx(0.00705)
    }
    assert body["timeline"][1] == {
        "ts": seeded["ts"][1], "tokens": 1650, "usd": pytest.approx(0.00495)
    }


@pytest.mark.parametrize(
    "bad_id",
    [
        "..%2F..%2Fetc%2Fpasswd",   # decoded by the router to ../../etc/passwd
        "..%5C..%5Cwindows",        # backslash traversal
        "foo.jsonl",                # extension smuggling
        "a.b",                      # any dot at all
        "...",
    ],
)
def test_usage_detail_rejects_traversal_ids(seeded, client, bad_id):
    resp = client.get(f"/cc/usage/{bad_id}")
    # Two defense layers, never a 500 and never file content: ids whose %2F
    # decodes to a real slash die in the ROUTER ({session_id} matches no
    # slashes -> plain 404); everything else reaches the handler regex and
    # gets the empty shape with the hostile id NOT echoed back.
    assert resp.status_code in (200, 404)
    if resp.status_code == 200:
        assert resp.json() == EMPTY_DETAIL
    else:
        assert resp.json() == {"detail": "Not Found"}
    assert "passwd" not in resp.text and "windows" not in resp.text


def test_usage_detail_unknown_id_404_empty_shape(seeded, client):
    resp = client.get("/cc/usage/deadbeefdeadbeef")
    assert resp.status_code == 404
    body = resp.json()
    assert body["session_id"] == "deadbeefdeadbeef"
    assert body["totals"] == EMPTY_DETAIL["totals"]
    assert body["by_model"] == [] and body["timeline"] == []


# --------------------------------------------------------------------------- #
# /cc/aggregate + /cc/heatmap
# --------------------------------------------------------------------------- #


def test_aggregate_shapes_and_sums(seeded, client):
    body = client.get("/cc/aggregate").json()
    assert set(body) == {"daily", "by_model", "cache", "peak_hours"}

    # daily buckets computed from the same ts the fixture wrote
    expected = {}
    for i, usd, tokens in TURNS:
        day = _local_dt(seeded["ts"][i]).date().isoformat()
        entry = expected.setdefault(day, [0, 0.0])
        entry[0] += tokens
        entry[1] += usd
    assert [(d["date"], d["tokens"]) for d in body["daily"]] == [
        (k, v[0]) for k, v in sorted(expected.items())
    ]
    for d in body["daily"]:
        assert d["usd"] == pytest.approx(expected[d["date"]][1])

    assert body["by_model"][0]["model"] == SONNET  # sorted by tokens desc
    models = {m["model"]: m for m in body["by_model"]}
    assert models[SONNET]["tokens"] == A_TOKENS
    assert models[SONNET]["usd"] == pytest.approx(A_USD)
    assert models[HAIKU]["tokens"] == B_TOKENS
    assert models[HAIKU]["usd"] == pytest.approx(B_USD)

    cache = body["cache"]
    assert cache["read"] == 1000
    assert cache["write"] == 1700  # 1000 cw5m + 500 cw1h + 200 legacy
    assert cache["saved_usd"] == pytest.approx(0.0027)  # 1000*(3.0-0.30)/1e6
    # input total = 160; prompt-side = 160 + 1000 + 1700
    assert cache["pct"] == pytest.approx(round(1000 / 2860 * 100, 1))

    assert len(body["peak_hours"]) == 24
    assert sum(body["peak_hours"]) == A_TOKENS + B_TOKENS


def test_heatmap_shape(seeded, client):
    body = client.get("/cc/heatmap").json()
    assert set(body) == {"days", "hours"}
    assert len(body["hours"]) == 24
    assert sum(body["hours"]) == A_TOKENS + B_TOKENS
    assert sum(d["tokens"] for d in body["days"]) == A_TOKENS + B_TOKENS
    for d in body["days"]:
        assert set(d) == {"date", "tokens", "usd"}


# --------------------------------------------------------------------------- #
# Degradation: missing dir / corrupt transcripts -> empty shapes, never 500
# --------------------------------------------------------------------------- #


def test_missing_dir_empty_shapes(client):
    # autouse fixture points CLAUDE_PROJECTS_DIR at a nonexistent path
    assert client.get("/cc/status").json() == {
        "active": False, "conversations": 0, "projects": 0,
        "storage_mb": 0.0, "this_month_usd": 0.0, "this_week_tokens": 0,
    }
    assert client.get("/cc/usage").json() == []
    assert client.get("/cc/aggregate").json() == {
        "daily": [], "by_model": [],
        "cache": {"read": 0, "write": 0, "saved_usd": 0.0, "pct": 0.0},
        "peak_hours": [0] * 24,
    }
    assert client.get("/cc/heatmap").json() == {"days": [], "hours": [0] * 24}


def test_corrupt_transcript_never_500(monkeypatch, tmp_path, client):
    root = tmp_path / "projects"
    proj = root / "-Users-jasonluo08-Desktop-broken"
    proj.mkdir(parents=True)
    (proj / "cafe0001.jsonl").write_bytes(b"\x00\xff\xfe garbage\n{torn json\n[1,2]\n")
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(root))

    status = client.get("/cc/status")
    assert status.status_code == 200
    assert status.json()["conversations"] == 1
    assert status.json()["this_month_usd"] == 0.0

    rows = client.get("/cc/usage").json()
    assert len(rows) == 1
    assert rows[0]["turns"] == 0 and rows[0]["total_tokens"] == 0

    detail = client.get("/cc/usage/cafe0001")
    assert detail.status_code == 200  # file exists: zero shape, not 404
    assert detail.json()["timeline"] == []

    assert client.get("/cc/aggregate").status_code == 200
    assert client.get("/cc/heatmap").status_code == 200


# --------------------------------------------------------------------------- #
# /config
# --------------------------------------------------------------------------- #


def test_config_shape_defaults(monkeypatch, tmp_path, client):
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    monkeypatch.delenv("ATELIER_MAX_TURNS", raising=False)
    monkeypatch.delenv("SWARM_JOBS_FILE", raising=False)
    # missing settings file -> the subscription/no-key defaults
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    body = client.get("/config").json()
    # workspace_dir resolves to a home-dependent path (the Reveal-in-Finder
    # target) — assert it is present + a non-empty string, then check the rest.
    assert isinstance(body.get("workspace_dir"), str) and body["workspace_dir"]
    body.pop("workspace_dir")
    assert body == {
        "model": lite_server._resolved_model(),
        "max_turns": 60,
        "scheduler": {"running": None},  # honestly unknowable from lite_server
        "jobs_file": "",
        "auth_mode": "origin-gate",
        "token_present": False,
        "provider": "subscription",
        "api_key_present": False,
        "api_key_hint": "",
        "notion_connected": False,
        "notion_token_hint": "",
        "obsidian_vault": "",
        "spend_cap_usd": 5.0,  # the mandatory default cap
    }


def test_config_max_turns_env(monkeypatch, client):
    monkeypatch.setenv("ATELIER_MAX_TURNS", "12")
    assert client.get("/config").json()["max_turns"] == 12
    monkeypatch.setenv("ATELIER_MAX_TURNS", "not-a-number")
    assert client.get("/config").json()["max_turns"] == 60


def test_config_and_cc_never_leak_token(seeded, monkeypatch, client):
    token = "sekrit-token-98765-do-not-leak"
    monkeypatch.setenv("ATELIER_TOKEN", token)
    monkeypatch.setenv("SWARM_JOBS_FILE", "/tmp/jobs.yaml")

    hdr = {"X-Atelier-Token": token}
    resp = client.get("/config", headers=hdr)  # every GET is token-gated now
    assert resp.status_code == 200
    body = resp.json()
    assert body["auth_mode"] == "token"
    assert body["token_present"] is True
    assert body["jobs_file"] == "/tmp/jobs.yaml"
    assert token not in resp.text

    for url in ("/cc/status", "/cc/usage", f"/cc/usage/{SESSION_A}",
                "/cc/aggregate", "/cc/heatmap"):
        r = client.get(url, headers=hdr)
        assert r.status_code == 200
        assert token not in r.text
