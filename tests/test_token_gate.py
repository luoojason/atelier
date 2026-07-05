"""The every-endpoint token gate (launch-readiness review 2026-07).

When ATELIER_TOKEN is set (the packaged app), EVERY route except /health
requires the per-launch token, supplied either as the X-Atelier-Token header
or — for loads that cannot set headers (<video src>, anchor downloads,
window.open) — the `atk` query param. Token unset (dev uvicorn, TestClient
without setenv) -> the gate is off and origin gating is the wall.

This replaced the earlier posture where read-only GETs were deliberately
open (accepted risk, closed 2026-07): a hostile "null"-origin page in a
browser without strict PNA enforcement could read /config, /cc/*, /tools,
/logs/backend, and /workspace/raw cross-origin.
"""

import pytest
from fastapi.testclient import TestClient

import lite_server

TOKEN = "sekret-launch-token"
HDR = {"X-Atelier-Token": TOKEN}


@pytest.fixture
def client():
    return TestClient(lite_server.app)


@pytest.fixture
def gated(monkeypatch):
    monkeypatch.setenv("ATELIER_TOKEN", TOKEN)


@pytest.fixture
def ungated(monkeypatch):
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)


# --------------------------------------------------------------------------- #
# gate ON (token set)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("path", ["/config", "/tools", "/cc/status", "/sessions",
                                  "/logs/backend", "/workspace/raw?path=x"])
def test_gets_require_token(gated, client, path):
    assert client.get(path).status_code == 403


@pytest.mark.parametrize("path", ["/config", "/tools", "/cc/status", "/sessions"])
def test_gets_pass_with_header(gated, client, path):
    assert client.get(path, headers=HDR).status_code == 200


def test_health_stays_exempt(gated, client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_atk_query_param_is_an_alternate_carrier(gated, client):
    assert client.get(f"/config?atk={TOKEN}").status_code == 200


def test_bad_atk_is_403(gated, client):
    assert client.get("/config?atk=wrong").status_code == 403


def test_non_ascii_atk_is_403_not_500(gated, client):
    # compare_digest(str, str) raises on non-ASCII; the gate compares bytes.
    assert client.get("/config?atk=caf%C3%A9").status_code == 403


def test_bad_header_is_403(gated, client):
    assert client.get("/config", headers={"X-Atelier-Token": "wrong"}).status_code == 403


def test_mutating_routes_still_gated(gated, client):
    assert client.post("/notify/read", json={}).status_code == 403


def test_cors_preflight_is_exempt(gated, client):
    """Preflights are anonymous by spec — the browser never attaches
    X-Atelier-Token to an OPTIONS. Gating them 403'd the preflight before
    CORSMiddleware could answer, breaking EVERY renderer fetch in the
    packaged app (the renderer is file://, so authenticated requests are
    always cross-origin + preflighted). Regression test for the hotfix."""
    resp = client.options(
        "/external/agents",
        headers={
            "Origin": "file://",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-atelier-token",
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "file://"
    # the real request that follows the preflight is still gated
    assert client.post("/external/agents", json={}).status_code == 403


def test_vault_gets_still_gated(gated, client):
    # the pre-2026-07 gate covered these three; regression-pin them
    for path in ("/vault/graph", "/vault/note?path=x", "/external/agents"):
        assert client.get(path).status_code == 403


# --------------------------------------------------------------------------- #
# gate OFF (token unset: dev uvicorn / plain-browser testing)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("path", ["/config", "/tools", "/cc/status"])
def test_gate_off_without_token(ungated, client, path):
    assert client.get(path).status_code == 200


def test_config_never_leaks_the_token_value(gated, client):
    resp = client.get("/config", headers=HDR)
    assert resp.status_code == 200
    assert TOKEN not in resp.text
    assert resp.json()["token_present"] is True
