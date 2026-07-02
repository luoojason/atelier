"""Tests for lite_server's scheduler compat route (POST /open-swarm/get_response)
via fastapi TestClient — no live server, no network, no real agent runs (the
claude-agent-sdk ClaudeSDKClient is monkeypatched at its boundary).

The route's contract (scheduler/client.py fires jobs at it):
  * accepts {"message", "recipient_agent"?} and returns {"response"}
    (+"error": true on failure, never a 500 — mirroring /chat);
  * uses a FRESH ClaudeSDKClient per request and never touches the long-lived
    chat client, so a scheduled fire cannot pollute the user's chat context.

Needs the extension venv (lite_server imports claude_agent_sdk + agency_swarm
tools):

    .venv-ext/bin/python -m pytest -q tests/test_lite_compat.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


class _FakeAssistant:
    """AssistantMessage stand-in carrying TextBlocks (duck-typed via isinstance
    patch below is unnecessary — we reuse the real block classes)."""


class _FakeChatClient:
    """Stands in for the long-lived chat client; any use fails a compat test."""

    async def query(self, *a, **k):
        raise AssertionError("the compat route must not touch the chat client")

    def receive_response(self):
        raise AssertionError("the compat route must not touch the chat client")


def _make_fresh_client_factory(reply="fresh reply", record=None):
    """Build a ClaudeSDKClient replacement class that yields one text reply.

    Records each queried message into ``record`` (a list) so tests can assert
    a fresh instance was used per request.
    """
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

    class _FreshClient:
        def __init__(self, options=None):
            self.options = options
            self._message = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def query(self, message):
            self._message = message
            if record is not None:
                record.append(message)

        async def receive_response(self):
            yield AssistantMessage(content=[TextBlock(text=reply)], model="test")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="s",
            )

    return _FreshClient


@pytest.fixture
def client():
    return TestClient(lite_server.app)


def test_compat_route_fresh_client_per_request_and_chat_isolation(
    monkeypatch, client
):
    built = []
    factory = _make_fresh_client_factory(record=None)

    class _Recording(factory):
        def __init__(self, options=None):
            super().__init__(options=options)
            built.append(self)

    monkeypatch.setattr(lite_server, "ClaudeSDKClient", _Recording)
    # If the route ever reaches for the long-lived chat client, this poisoned
    # stand-in raises and the request surfaces "error": true.
    monkeypatch.setattr(lite_server, "_chat_client", _FakeChatClient())

    resp = client.post("/open-swarm/get_response", json={"message": "morning brief"})
    assert resp.status_code == 200
    assert resp.json() == {"response": "fresh reply"}
    assert len(built) == 1
    assert built[0]._message == "morning brief"

    # A second fire builds a SECOND fresh client: no state carried between runs.
    resp = client.post("/open-swarm/get_response", json={"message": "rollup"})
    assert resp.status_code == 200
    assert len(built) == 2
    assert built[1]._message == "rollup"


def test_compat_route_accepts_recipient_agent(monkeypatch, client):
    record = []
    monkeypatch.setattr(
        lite_server,
        "ClaudeSDKClient",
        _make_fresh_client_factory(record=record),
    )

    resp = client.post(
        "/open-swarm/get_response",
        json={"message": "hi", "recipient_agent": "Atelier"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"response": "fresh reply"}
    # recipient_agent is accepted (no 422) but ignored — the message still runs.
    assert record == ["hi"]


def test_compat_route_error_shape_never_500(monkeypatch, client):
    class _ExplodingClient:
        def __init__(self, options=None):
            pass

        async def __aenter__(self):
            raise RuntimeError("model backend down")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(lite_server, "ClaudeSDKClient", _ExplodingClient)

    resp = client.post("/open-swarm/get_response", json={"message": "hi"})
    assert resp.status_code == 200  # mirrors /chat: never a 500
    body = resp.json()
    assert body["error"] is True
    assert "model backend down" in body["response"]


def test_compat_route_failed_result_is_error_shape(monkeypatch, client):
    from claude_agent_sdk import ResultMessage

    class _FailingClient:
        def __init__(self, options=None):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def query(self, message):
            pass

        async def receive_response(self):
            yield ResultMessage(
                subtype="error_max_turns",
                duration_ms=1,
                duration_api_ms=1,
                is_error=True,
                num_turns=12,
                session_id="s",
                result="hit the turn ceiling",
            )

    monkeypatch.setattr(lite_server, "ClaudeSDKClient", _FailingClient)

    resp = client.post("/open-swarm/get_response", json={"message": "hi"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] is True
    assert "hit the turn ceiling" in body["response"]


def test_chat_uses_the_long_lived_client(monkeypatch, client):
    # The inverse isolation: /chat keeps continuity on the ONE lazily-connected
    # chat client and never opens a fresh per-request client.
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

    queried = []

    class _ChatClient:
        async def query(self, message):
            queried.append(message)

        async def receive_response(self):
            yield AssistantMessage(
                content=[TextBlock(text="chat reply")], model="test"
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="s",
            )

    # Pre-seed the module-level chat client so _get_chat_client returns it
    # without connecting, and make opening a fresh client fail loudly.
    monkeypatch.setattr(lite_server, "_chat_client", _ChatClient())

    class _NoFresh:
        def __init__(self, options=None):
            raise AssertionError("/chat must not open a fresh client")

    monkeypatch.setattr(lite_server, "ClaudeSDKClient", _NoFresh)

    resp = client.post("/chat", json={"message": "hello"})
    assert resp.status_code == 200
    assert resp.json() == {"response": "chat reply"}
    assert queried == ["hello"]
