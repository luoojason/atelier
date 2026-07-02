"""Tests for lite_server's SSE streaming chat route (POST /chat/stream).

Same boundary-mock style as test_lite_compat.py: the long-lived chat client is
replaced at _get_chat_client, so no network and no real agent runs. Asserts the
SSE wire shape the renderer's streamChat() parses:

  * one {"delta": ...} event per text_delta StreamEvent (thinking/signature
    deltas filtered out);
  * exactly one final {"done": true, "response": <canonical full text>} built
    from the complete AssistantMessage TextBlocks (NOT the deltas);
  * a failed ResultMessage or a raised exception surfaces as
    {"done": true, "error": true, "response": ...} — never a broken stream;
  * a mid-turn exception tears down the chat client (reset) so the next turn
    reconnects.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_lite_stream.py
"""

import asyncio
import json
import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


def _stream_event(delta_type, text=None):
    from claude_agent_sdk import StreamEvent

    delta = {"type": delta_type}
    if text is not None:
        delta["text"] = text
    return StreamEvent(
        uuid="u",
        session_id="s",
        event={"type": "content_block_delta", "delta": delta},
    )


def _result(is_error=False, result=None):
    from claude_agent_sdk import ResultMessage

    return ResultMessage(
        subtype="error" if is_error else "success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=is_error,
        num_turns=1,
        session_id="s",
        result=result,
    )


def _assistant(text):
    from claude_agent_sdk import AssistantMessage, TextBlock

    return AssistantMessage(content=[TextBlock(text=text)], model="test")


class _StreamingChatClient:
    """Long-lived chat-client stand-in yielding a scripted message sequence."""

    def __init__(self, script):
        self._script = script
        self.queried = []

    async def query(self, message):
        self.queried.append(message)

    async def receive_response(self):
        for msg in self._script:
            yield msg

    async def disconnect(self):
        pass


def _events(resp):
    """Parse an SSE body into the list of decoded data objects."""
    out = []
    for chunk in resp.text.split("\n\n"):
        for line in chunk.split("\n"):
            if line.startswith("data: "):
                out.append(json.loads(line[len("data: ") :]))
    return out


@pytest.fixture
def client():
    return TestClient(lite_server.app)


@pytest.fixture(autouse=True)
def _clean_chat_client(monkeypatch):
    monkeypatch.setattr(lite_server, "_chat_client", None)


def _install(monkeypatch, fake):
    async def _get():
        return fake

    monkeypatch.setattr(lite_server, "_get_chat_client", _get)


def test_stream_deltas_then_canonical_final(monkeypatch, client):
    fake = _StreamingChatClient(
        [
            _stream_event("text_delta", "Hel"),
            _stream_event("thinking_delta", "internal"),  # must be filtered
            _stream_event("signature_delta"),  # must be filtered
            _stream_event("text_delta", "lo"),
            _assistant("Hello there"),  # canonical full text differs from deltas
            _result(),
        ]
    )
    _install(monkeypatch, fake)

    resp = client.post("/chat/stream", json={"message": "hi"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = _events(resp)
    assert [e["delta"] for e in events if "delta" in e] == ["Hel", "lo"]
    finals = [e for e in events if e.get("done")]
    assert len(finals) == 1
    assert finals[0] == {"done": True, "response": "Hello there"}
    assert fake.queried == ["hi"]


def test_stream_failed_result_is_an_error_event(monkeypatch, client):
    fake = _StreamingChatClient(
        [
            _stream_event("text_delta", "partial"),
            _result(is_error=True, result="rate limited"),
        ]
    )
    _install(monkeypatch, fake)

    events = _events(client.post("/chat/stream", json={"message": "hi"}))
    final = [e for e in events if e.get("done")][0]
    assert final["error"] is True
    assert "rate limited" in final["response"]


def test_stream_exception_yields_error_event_and_resets_client(monkeypatch, client):
    class _Exploding(_StreamingChatClient):
        async def query(self, message):
            raise RuntimeError("transport died")

    _install(monkeypatch, _Exploding([]))
    resets = []

    async def _reset():
        resets.append(True)

    monkeypatch.setattr(lite_server, "_reset_chat_client", _reset)

    resp = client.post("/chat/stream", json={"message": "hi"})
    assert resp.status_code == 200
    final = [e for e in _events(resp) if e.get("done")][0]
    assert final["error"] is True
    assert "transport died" in final["response"]
    assert resets == [True]


def test_stream_cancelled_mid_turn_resets_client(monkeypatch):
    """A mid-turn client disconnect throws CancelledError into the generator
    (BaseException, not Exception) at the point it is suspended mid-stream.
    That must still reset the shared chat client, or the next turn reads the
    stale unconsumed ResultMessage left in the client's buffer."""
    fake = _StreamingChatClient([_stream_event("text_delta", "Hel")])
    _install(monkeypatch, fake)
    resets = []

    async def _reset():
        resets.append(True)

    monkeypatch.setattr(lite_server, "_reset_chat_client", _reset)

    async def _drive():
        gen = lite_server._stream_turn("hi")
        # Advance past the first delta so the generator is suspended
        # mid-stream (mirrors a client that disconnects after partial
        # streaming but before the final "done" event).
        first = await gen.__anext__()
        with pytest.raises(asyncio.CancelledError):
            await gen.athrow(asyncio.CancelledError())
        return first

    first = asyncio.run(_drive())
    assert json.loads(first.strip()[len("data: ") :]) == {"delta": "Hel"}
    assert resets == [True]


def test_stream_closed_mid_turn_resets_client(monkeypatch):
    """Same scenario via GeneratorExit (a consumer closing the generator
    directly), the other BaseException the mid-stream disconnect can raise."""
    fake = _StreamingChatClient([_stream_event("text_delta", "Hel")])
    _install(monkeypatch, fake)
    resets = []

    async def _reset():
        resets.append(True)

    monkeypatch.setattr(lite_server, "_reset_chat_client", _reset)

    async def _drive():
        gen = lite_server._stream_turn("hi")
        await gen.__anext__()
        await gen.aclose()

    asyncio.run(_drive())
    assert resets == [True]


def test_stream_clean_completion_does_not_reset_client(monkeypatch, client):
    fake = _StreamingChatClient(
        [
            _stream_event("text_delta", "Hi"),
            _assistant("Hi"),
            _result(),
        ]
    )
    _install(monkeypatch, fake)
    resets = []

    async def _reset():
        resets.append(True)

    monkeypatch.setattr(lite_server, "_reset_chat_client", _reset)

    resp = client.post("/chat/stream", json={"message": "hi"})
    assert resp.status_code == 200
    assert resets == []


def test_nonstream_chat_ignores_stream_events(monkeypatch, client):
    """/chat on a stream-enabled client must not duplicate or leak deltas."""
    fake = _StreamingChatClient(
        [
            _stream_event("text_delta", "Hel"),
            _stream_event("text_delta", "lo"),
            _assistant("Hello"),
            _result(),
        ]
    )
    _install(monkeypatch, fake)

    resp = client.post("/chat", json={"message": "hi"})
    assert resp.status_code == 200
    assert resp.json() == {"response": "Hello"}
