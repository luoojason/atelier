"""Tests for lite_server's scheduler compat route (POST /open-swarm/get_response)
via fastapi TestClient — no live server, no network, no real agent runs (the
agency factory is monkeypatched).

The route's contract (scheduler/client.py fires jobs at it):
  * accepts {"message", "recipient_agent"?} and returns {"response"}
    (+"error": true on failure, never a 500 — mirroring /chat);
  * builds a FRESH agency per request via build_agency() and never touches the
    module-level chat agency, so a scheduled fire cannot pollute the user's
    chat context.

Needs the extension venv (lite_server imports agency_swarm):

    .venv-ext/bin/python -m pytest -q tests/test_lite_compat.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("agency_swarm")

# Importing lite_server setdefaults DEFAULT_MODEL and CLAUDE_ISOLATED process-
# wide; snapshot and restore so the rest of the pytest run is unaffected.
_HAD_ISOLATED = "CLAUDE_ISOLATED" in os.environ
import lite_server  # noqa: E402

if not _HAD_ISOLATED:
    os.environ.pop("CLAUDE_ISOLATED", None)

from fastapi.testclient import TestClient  # noqa: E402


class _FakeResult:
    final_output = "fresh reply"


class _FakeAgency:
    """Stands in for a freshly built Agency; records every get_response_sync."""

    def __init__(self):
        self.calls = []

    def get_response_sync(self, message, **kwargs):
        self.calls.append((message, kwargs))
        return _FakeResult()


class _PoisonedAgency:
    """Any use of the module-level chat agency fails the test loudly."""

    def get_response_sync(self, *args, **kwargs):
        raise AssertionError("the compat route must not touch the chat agency")


@pytest.fixture
def client():
    return TestClient(lite_server.app)


def test_compat_route_fresh_agency_per_request_and_chat_isolation(
    monkeypatch, client
):
    built = []

    def factory():
        fake = _FakeAgency()
        built.append(fake)
        return fake

    monkeypatch.setattr(lite_server, "build_agency", factory)
    # If the route ever falls back to the shared conversational agency, the
    # poisoned stand-in raises and the request surfaces "error": true below.
    monkeypatch.setattr(lite_server, "agency", _PoisonedAgency())

    resp = client.post("/open-swarm/get_response", json={"message": "morning brief"})
    assert resp.status_code == 200
    assert resp.json() == {"response": "fresh reply"}
    assert len(built) == 1
    assert built[0].calls == [("morning brief", {})]

    # A second fire builds a SECOND fresh agency: no state is carried between
    # scheduled runs either.
    resp = client.post("/open-swarm/get_response", json={"message": "rollup"})
    assert resp.status_code == 200
    assert len(built) == 2
    assert built[1].calls == [("rollup", {})]


def test_compat_route_passes_recipient_agent(monkeypatch, client):
    built = []

    def factory():
        fake = _FakeAgency()
        built.append(fake)
        return fake

    monkeypatch.setattr(lite_server, "build_agency", factory)

    resp = client.post(
        "/open-swarm/get_response",
        json={"message": "hi", "recipient_agent": "Atelier"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"response": "fresh reply"}
    assert built[0].calls == [("hi", {"recipient_agent": "Atelier"})]


def test_compat_route_error_shape_never_500(monkeypatch, client):
    class _ExplodingAgency:
        def get_response_sync(self, *args, **kwargs):
            raise RuntimeError("model backend down")

    monkeypatch.setattr(lite_server, "build_agency", _ExplodingAgency)

    resp = client.post("/open-swarm/get_response", json={"message": "hi"})
    assert resp.status_code == 200  # mirrors /chat: never a 500
    body = resp.json()
    assert body["error"] is True
    assert "model backend down" in body["response"]


def test_chat_still_uses_the_module_level_agency(monkeypatch, client):
    # The inverse isolation: /chat keeps its conversational continuity on the
    # shared module-level agency and never builds a fresh one.
    def exploding_factory():
        raise AssertionError("/chat must not build a fresh agency")

    shared = _FakeAgency()
    monkeypatch.setattr(lite_server, "build_agency", exploding_factory)
    monkeypatch.setattr(lite_server, "agency", shared)

    resp = client.post("/chat", json={"message": "hello"})
    assert resp.status_code == 200
    assert resp.json() == {"response": "fresh reply"}
    assert shared.calls == [("hello", {})]
