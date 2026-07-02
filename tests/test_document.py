"""Tests for lite_server's POST /document — the ported docs_agent deliverable
(one-shot print-ready HTML document generator). Same harness style as
test_miniapp.py: ClaudeSDKClient monkeypatched at its boundary, the long-lived
chat client poisoned, no live server, no network.

Contract (app/document.js posts these shapes):
  * POST /document {"description"} (3..4000) + optional {"title"} (<=200) ->
    {"html", "title"} on success else {"error"}; never a 500;
  * a FRESH client per request built from the document options variant:
    DOCUMENT system prompt, max_turns=6, allowed_tools=[], mcp_servers={} —
    build_options() itself untouched;
  * title echoes the caller hint, else falls back to the document's <title>
    then its first <h1>, else "document";
  * POST is token-gated by the method-based middleware when ATELIER_TOKEN set.

    .venv-ext/bin/python -m pytest -q tests/test_document.py
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


DOC = "<!doctype html><html><body><h1>Quarterly Review</h1></body></html>"


class _PoisonChatClient:
    async def query(self, *a, **k):
        raise AssertionError("/document must not touch the chat client")

    def receive_response(self):
        raise AssertionError("/document must not touch the chat client")

    async def disconnect(self):
        pass


def _assistant(text):
    from claude_agent_sdk import AssistantMessage, TextBlock

    return AssistantMessage(content=[TextBlock(text=text)], model="test")


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


def _scripted_client_factory(script=None, built=None, query_error=None):
    if script is None:
        script = [_assistant(f"```html\n{DOC}\n```"), _result()]

    class _Client:
        def __init__(self, options=None):
            self.options = options
            self.queried = []
            if built is not None:
                built.append(self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def query(self, message):
            self.queried.append(message)
            if query_error is not None:
                raise query_error

        async def receive_response(self):
            for msg in script:
                yield msg

    return _Client


class _NeverBuiltClient:
    def __init__(self, options=None):
        raise AssertionError("no client may be built for a rejected request")


def _install(monkeypatch, factory):
    monkeypatch.setattr(lite_server, "ClaudeSDKClient", factory)


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch, tmp_path):
    monkeypatch.setattr(lite_server, "_chat_client", _PoisonChatClient())
    monkeypatch.setenv("ATELIER_SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)


@pytest.fixture
def client():
    return TestClient(lite_server.app)


# ── success + title fallback ─────────────────────────────────────────────────

def test_generates_document_and_titles_from_h1(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    resp = client.post("/document", json={"description": "a quarterly review"})
    assert resp.status_code == 200
    assert resp.json() == {"html": DOC, "title": "Quarterly Review"}
    # the caller's description reaches the model verbatim (no title hint)
    assert built[0].queried == ["a quarterly review"]


def test_caller_title_hint_wins_and_prefixes_the_prompt(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    resp = client.post(
        "/document",
        json={"description": "sum up Q3", "title": "Q3 Board Memo"},
    )
    assert resp.json()["title"] == "Q3 Board Memo"
    assert built[0].queried == ['Document title: "Q3 Board Memo"\n\nsum up Q3']


def test_title_falls_back_to_title_tag_then_h1_then_default(monkeypatch, client):
    cases = [
        ("<title>Annual Report</title><h1>Ignored</h1>", "Annual Report"),
        ("<html><h1>Just a Heading</h1></html>", "Just a Heading"),
        ("<html><body><p>no headings here</p></body></html>", "document"),
    ]
    for body, want in cases:
        doc = f"<!doctype html><html>{body}</html>"
        _install(monkeypatch, _scripted_client_factory(
            script=[_assistant(doc), _result()],
        ))
        got = client.post("/document", json={"description": "make a doc"}).json()
        assert got["title"] == want, (body, got)


def test_document_title_strips_inner_tags(monkeypatch, client):
    doc = "<!doctype html><html><h1>Plan <em>for</em> 2027</h1></html>"
    _install(monkeypatch, _scripted_client_factory(
        script=[_assistant(doc), _result()],
    ))
    assert client.post(
        "/document", json={"description": "a plan"}
    ).json()["title"] == "Plan for 2027"


# ── the document options variant + untouched builder ─────────────────────────

def test_options_variant_and_untouched_builder(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    assert client.post(
        "/document", json={"description": "a memo"}
    ).status_code == 200
    opts = built[0].options
    assert opts.system_prompt == lite_server.DOCUMENT_INSTRUCTIONS
    assert opts.system_prompt != lite_server.ATELIER_INSTRUCTIONS
    assert opts.max_turns == 6
    assert opts.allowed_tools == []
    assert opts.mcp_servers == {}
    # the shared builder is untouched
    assert lite_server.build_options().system_prompt == lite_server.ATELIER_INSTRUCTIONS


def test_fresh_client_per_request(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    client.post("/document", json={"description": "doc one"})
    client.post("/document", json={"description": "doc two"})
    assert len(built) == 2
    assert built[1].queried == ["doc two"]


# ── extraction failure + size cap ────────────────────────────────────────────

def test_unextractable_reply(monkeypatch, client):
    for reply in ("Sorry, I cannot.", "", "```html\n\n```", "prose <html> tag"):
        _install(monkeypatch, _scripted_client_factory(
            script=[_assistant(reply), _result()],
        ))
        body = client.post("/document", json={"description": "a doc"}).json()
        assert body == {"error": "the model did not return a usable HTML document"}


def test_size_cap(monkeypatch, client):
    huge = "<!doctype html><html>" + "x" * 300_001 + "</html>"
    _install(monkeypatch, _scripted_client_factory(
        script=[_assistant(huge), _result()],
    ))
    assert client.post("/document", json={"description": "big"}).json() == {
        "error": "generated document too large"
    }


# ── validation + error semantics ─────────────────────────────────────────────

def test_validation(monkeypatch, client):
    _install(monkeypatch, _NeverBuiltClient)
    for body in (
        {"description": "ab"},          # below min 3
        {"description": "x" * 4001},    # above max 4000
        {"description": "ok", "title": "t" * 201},  # title over 200
        {},
    ):
        assert client.post("/document", json=body).status_code == 422


def test_failed_result_surfaces_as_error(monkeypatch, client):
    _install(monkeypatch, _scripted_client_factory(
        script=[_result(is_error=True, result="rate limited")],
    ))
    resp = client.post("/document", json={"description": "a memo"})
    assert resp.status_code == 200
    assert "rate limited" in resp.json()["error"]


def test_exception_never_500s(monkeypatch, client):
    _install(monkeypatch, _scripted_client_factory(
        query_error=RuntimeError("transport died"),
    ))
    resp = client.post("/document", json={"description": "a memo"})
    assert resp.status_code == 200
    assert "transport died" in resp.json()["error"]


# ── token gate ───────────────────────────────────────────────────────────────

def test_document_is_token_gated(monkeypatch, client):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    assert client.post("/document", json={"description": "a memo"}).status_code == 403
    assert built == []
    ok = client.post(
        "/document",
        json={"description": "a memo"},
        headers={"X-Atelier-Token": "sekret"},
    )
    assert ok.status_code == 200
    assert ok.json()["html"] == DOC
