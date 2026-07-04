"""Tests for lite_server's POST /research — the ported deep_research deliverable
(a keyless cited HTML report). Same harness as test_document.py / test_miniapp.py:
ClaudeSDKClient monkeypatched at its boundary, chat client poisoned, no network.

Contract:
  * POST /research {"description"} (3..4000) + optional {"title"} (<=200) ->
    {"html","title"} on success else {"error"}; never a 500;
  * a FRESH client per request from the research options variant: RESEARCH
    system prompt, max_turns=30, allow-lists ONLY the two keyless web tools,
    KEEPS the atelier MCP server; build_options() untouched;
  * unextractable -> "the model did not return a usable HTML report";
    >300k -> "generated report too large";
  * POST token-gated by the method middleware when ATELIER_TOKEN set.

    .venv-ext/bin/python -m pytest -q tests/test_research.py
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


DOC = "<!doctype html><html><head><title>AI Market 2027</title></head><body><h1>Report</h1></body></html>"


class _PoisonChatClient:
    async def query(self, *a, **k):
        raise AssertionError("/research must not touch the chat client")

    def receive_response(self):
        raise AssertionError("/research must not touch the chat client")

    async def disconnect(self):
        pass


def _assistant(text):
    from claude_agent_sdk import AssistantMessage, TextBlock
    return AssistantMessage(content=[TextBlock(text=text)], model="test")


def _result(is_error=False, result=None):
    from claude_agent_sdk import ResultMessage
    return ResultMessage(
        subtype="error" if is_error else "success",
        duration_ms=1, duration_api_ms=1, is_error=is_error,
        num_turns=1, session_id="s", result=result,
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


def test_generates_report_and_titles_from_title_tag(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    resp = client.post("/research", json={"description": "the AI market in 2027"})
    assert resp.status_code == 200
    assert resp.json() == {"html": DOC, "title": "AI Market 2027"}
    assert built[0].queried == ["the AI market in 2027"]


def test_caller_title_prefixes_prompt(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    resp = client.post("/research", json={"description": "compare X and Y", "title": "X vs Y"})
    assert resp.json()["title"] == "X vs Y"
    assert built[0].queried == ['Report title: "X vs Y"\n\ncompare X and Y']


def test_research_options_allow_only_web_tools(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    assert client.post("/research", json={"description": "study topic"}).status_code == 200
    opts = built[0].options
    assert opts.system_prompt == lite_server.RESEARCH_INSTRUCTIONS
    assert opts.system_prompt != lite_server.ATELIER_INSTRUCTIONS
    assert opts.max_turns == 30
    # ONLY the two keyless web tools are allowed — no campaign/vault/notion/orchestra
    assert set(opts.allowed_tools) == {"mcp__atelier__WebSearch", "mcp__atelier__WebFetch"}
    # but the atelier server is still present (that's where those tools live)
    assert "atelier" in opts.mcp_servers
    assert "orchestra" not in opts.mcp_servers
    # the shared builder is untouched
    assert lite_server.build_options().system_prompt == lite_server.ATELIER_INSTRUCTIONS


def test_fresh_client_per_request(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    client.post("/research", json={"description": "topic one"})
    client.post("/research", json={"description": "topic two"})
    assert len(built) == 2
    assert built[1].queried == ["topic two"]


def test_unextractable_reply(monkeypatch, client):
    for reply in ("I could not find sources.", "", "```html\n\n```"):
        _install(monkeypatch, _scripted_client_factory(
            script=[_assistant(reply), _result()],
        ))
        body = client.post("/research", json={"description": "a topic"}).json()
        assert body == {"error": "the model did not return a usable HTML report"}


def test_size_cap(monkeypatch, client):
    huge = "<!doctype html><html>" + "x" * 300_001 + "</html>"
    _install(monkeypatch, _scripted_client_factory(
        script=[_assistant(huge), _result()],
    ))
    assert client.post("/research", json={"description": "big"}).json() == {
        "error": "generated report too large"
    }


def test_validation(monkeypatch, client):
    _install(monkeypatch, _NeverBuiltClient)
    for body in ({"description": "ab"}, {"description": "x" * 4001},
                 {"description": "ok", "title": "t" * 201}, {}):
        assert client.post("/research", json=body).status_code == 422


def test_failure_and_exception_never_500(monkeypatch, client):
    _install(monkeypatch, _scripted_client_factory(
        script=[_result(is_error=True, result="rate limited")],
    ))
    r1 = client.post("/research", json={"description": "topic"})
    assert r1.status_code == 200 and "rate limited" in r1.json()["error"]
    _install(monkeypatch, _scripted_client_factory(query_error=RuntimeError("boom")))
    r2 = client.post("/research", json={"description": "topic"})
    assert r2.status_code == 200 and "boom" in r2.json()["error"]


def test_research_is_token_gated(monkeypatch, client):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    assert client.post("/research", json={"description": "topic"}).status_code == 403
    assert built == []
    ok = client.post("/research", json={"description": "topic"},
                     headers={"X-Atelier-Token": "sekret"})
    assert ok.status_code == 200 and ok.json()["html"] == DOC
