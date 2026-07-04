"""Tests for lite_server's slide-deck deliverable — POST /deck (structured deck
+ HTML preview) and POST /deck/pptx (a real .pptx via python-pptx). Same harness
as test_document.py: ClaudeSDKClient monkeypatched, chat client poisoned, no
network. /deck/pptx runs the REAL python-pptx builder (no LLM) and the result is
validated as an OOXML zip.

    .venv-ext/bin/python -m pytest -q tests/test_deck.py
"""

import base64
import io
import os
import sys
import zipfile

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

pytest.importorskip("claude_agent_sdk")
pytest.importorskip("pptx")

import lite_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


DECK_JSON = (
    '{"title":"Q3 Review","subtitle":"Team sync","slides":['
    '{"title":"Wins","bullets":["Shipped X","Grew Y"],"notes":"be upbeat"},'
    '{"title":"Risks","bullets":["Latency"]}]}'
)


class _PoisonChatClient:
    async def query(self, *a, **k):
        raise AssertionError("/deck must not touch the chat client")

    def receive_response(self):
        raise AssertionError("/deck must not touch the chat client")

    async def disconnect(self):
        pass


def _assistant(text):
    from claude_agent_sdk import AssistantMessage, TextBlock
    return AssistantMessage(content=[TextBlock(text=text)], model="test")


def _result(is_error=False, result=None):
    from claude_agent_sdk import ResultMessage
    return ResultMessage(subtype="error" if is_error else "success", duration_ms=1,
                         duration_api_ms=1, is_error=is_error, num_turns=1,
                         session_id="s", result=result)


def _scripted_client_factory(script=None, built=None, query_error=None):
    if script is None:
        script = [_assistant(DECK_JSON), _result()]

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


# ── /deck ────────────────────────────────────────────────────────────────────

def test_deck_returns_structure_and_preview(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    body = client.post("/deck", json={"description": "review Q3"}).json()
    assert body["title"] == "Q3 Review"
    assert body["deck"]["subtitle"] == "Team sync"
    assert [s["title"] for s in body["deck"]["slides"]] == ["Wins", "Risks"]
    assert body["deck"]["slides"][0]["bullets"] == ["Shipped X", "Grew Y"]
    assert body["deck"]["slides"][0]["notes"] == "be upbeat"
    # preview html is self-contained + escapes content, one card per slide + title
    assert body["html"].startswith("<!doctype html>")
    assert "Q3 Review" in body["html"] and "Wins" in body["html"]
    assert built[0].queried == ["review Q3"]


def test_deck_fenced_json_and_caller_title(monkeypatch, client):
    fenced = "Here you go:\n```json\n" + DECK_JSON + "\n```\n"
    _install(monkeypatch, _scripted_client_factory(script=[_assistant(fenced), _result()]))
    body = client.post("/deck", json={"description": "make a deck", "title": "My Deck"}).json()
    assert body["title"] == "My Deck" and body["deck"]["title"] == "My Deck"
    assert len(body["deck"]["slides"]) == 2


def test_deck_caps_slides_and_bullets(monkeypatch, client):
    many = {"title": "Big", "slides": [
        {"title": f"S{i}", "bullets": [f"b{j}" for j in range(30)]} for i in range(60)
    ]}
    import json as _j
    _install(monkeypatch, _scripted_client_factory(script=[_assistant(_j.dumps(many)), _result()]))
    deck = client.post("/deck", json={"description": "a big deck"}).json()["deck"]
    assert len(deck["slides"]) == lite_server._MAX_DECK_SLIDES
    assert len(deck["slides"][0]["bullets"]) == lite_server._MAX_DECK_BULLETS


def test_deck_unusable_reply(monkeypatch, client):
    for reply in ("sorry no", "", '{"title":"x"}', '{"slides":[]}', "```json\n{}\n```"):
        _install(monkeypatch, _scripted_client_factory(script=[_assistant(reply), _result()]))
        body = client.post("/deck", json={"description": "a deck"}).json()
        assert body == {"error": "the model did not return a usable slide deck"}


def test_deck_options_variant(monkeypatch, client):
    built = []
    _install(monkeypatch, _scripted_client_factory(built=built))
    client.post("/deck", json={"description": "a deck"})
    opts = built[0].options
    assert opts.system_prompt == lite_server.DECK_INSTRUCTIONS
    assert opts.max_turns == 6 and opts.allowed_tools == [] and opts.mcp_servers == {}
    assert lite_server.build_options().system_prompt == lite_server.ATELIER_INSTRUCTIONS


def test_deck_validation_and_never_500(monkeypatch, client):
    _install(monkeypatch, _scripted_client_factory(query_error=RuntimeError("boom")))
    r = client.post("/deck", json={"description": "a deck"})
    assert r.status_code == 200 and "boom" in r.json()["error"]
    assert client.post("/deck", json={"description": "ab"}).status_code == 422


def test_deck_token_gated(monkeypatch, client):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    _install(monkeypatch, _scripted_client_factory())
    assert client.post("/deck", json={"description": "a deck"}).status_code == 403
    ok = client.post("/deck", json={"description": "a deck"}, headers={"X-Atelier-Token": "sekret"})
    assert ok.status_code == 200


# ── /deck/pptx (real python-pptx build) ──────────────────────────────────────

def test_pptx_builds_valid_openxml(client):
    payload = {"title": "Q3 Review", "subtitle": "Sync", "slides": [
        {"title": "Wins", "bullets": ["Shipped X", "Grew Y"], "notes": "n"},
        {"title": "Risks", "bullets": ["Latency"]},
    ]}
    body = client.post("/deck/pptx", json=payload).json()
    assert body["title"] == "Q3 Review"
    data = base64.b64decode(body["pptx_b64"])
    # a .pptx is an OOXML zip: PK magic + the presentation part + a slide per content slide
    assert data[:2] == b"PK"
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()
    assert "ppt/presentation.xml" in names
    assert "[Content_Types].xml" in names
    slide_parts = [n for n in names if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
    assert len(slide_parts) == 3  # title slide + 2 content slides


def test_pptx_empty_slides_rejected(client):
    assert client.post("/deck/pptx", json={"title": "x", "slides": []}).status_code == 400


def test_pptx_token_gated(monkeypatch, client):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    payload = {"title": "x", "slides": [{"title": "a", "bullets": ["b"]}]}
    assert client.post("/deck/pptx", json=payload).status_code == 403
    ok = client.post("/deck/pptx", json=payload, headers={"X-Atelier-Token": "sekret"})
    assert ok.status_code == 200 and ok.json()["pptx_b64"]


# ── _extract_deck unit ───────────────────────────────────────────────────────

def test_extract_deck_raw_and_fenced():
    for raw in (DECK_JSON, "```json\n" + DECK_JSON + "\n```"):
        d = lite_server._extract_deck(raw)
        assert d and d["title"] == "Q3 Review" and len(d["slides"]) == 2
    assert lite_server._extract_deck("no json here") is None
