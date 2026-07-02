"""Notion tools over a mocked httpx (no network). Token comes from a tmp
ATELIER_SETTINGS_PATH; every failure mode returns an explicit string."""

import json
import os

import pytest

from shared_tools import notion_tools


@pytest.fixture
def token(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"notion_token": "secret_abc"}), encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    return "secret_abc"


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def test_missing_token_returns_not_connected(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text("{}", encoding="utf-8")
    os.environ["ATELIER_SETTINGS_PATH"] = str(p)
    assert notion_tools.NotionSearch(query="x").run() == notion_tools.NOT_CONNECTED


def test_search_formats_results(token, monkeypatch):
    payload = {"results": [
        {"object": "page", "id": "id1", "url": "https://notion.so/id1",
         "properties": {"Name": {"type": "title",
                                 "title": [{"plain_text": "My Page"}]}}},
    ]}
    monkeypatch.setattr(notion_tools.httpx, "post",
                        lambda *a, **k: _Resp(200, payload))
    out = notion_tools.NotionSearch(query="my").run()
    assert "My Page" in out and "id1" in out and "https://notion.so/id1" in out


def test_search_api_error_is_explicit(token, monkeypatch):
    monkeypatch.setattr(notion_tools.httpx, "post",
                        lambda *a, **k: _Resp(401, {"message": "unauthorized"}))
    out = notion_tools.NotionSearch(query="my").run()
    assert "401" in out and "failed" in out.lower()


def test_read_resolves_url_to_id(token, monkeypatch):
    seen = {}

    def fake_get(url, *a, **k):
        seen["url"] = url
        if url.endswith("/blocks/" + "a" * 32 + "/children"):
            return _Resp(200, {"results": []})
        return _Resp(200, {"properties": {"title": {"type": "title",
                     "title": [{"plain_text": "Doc"}]}}})

    monkeypatch.setattr(notion_tools.httpx, "get", fake_get)
    out = notion_tools.NotionRead(page="https://www.notion.so/My-Doc-" + "a" * 32).run()
    assert "Doc" in out
    assert "a" * 32 in seen["url"]


def test_create_page_returns_url(token, monkeypatch):
    captured = {}

    def fake_post(url, *a, **k):
        captured["json"] = k.get("json")
        return _Resp(200, {"url": "https://notion.so/new"})

    monkeypatch.setattr(notion_tools.httpx, "post", fake_post)
    out = notion_tools.NotionCreatePage(parent_id="parent", title="T",
                                        content="hello").run()
    assert "https://notion.so/new" in out
    assert captured["json"]["parent"] == {"page_id": "parent"}


def test_append_ok(token, monkeypatch):
    monkeypatch.setattr(notion_tools.httpx, "patch",
                        lambda *a, **k: _Resp(200, {"results": []}))
    out = notion_tools.NotionAppend(page_id="pg", content="more text").run()
    assert "ok" in out.lower()


def test_paragraph_blocks_chunks_long_text():
    blocks = notion_tools._paragraph_blocks("x" * 4500)
    # Notion caps rich_text content at 2000 chars per block.
    assert all(len(b["paragraph"]["rich_text"][0]["text"]["content"]) <= 2000
               for b in blocks)
    assert len(blocks) >= 3


# ── _extract_id: real "Copy link" URLs, dashed UUIDs, raw ids ──────────────────

def test_extract_id_from_notion_url_with_query_string():
    page_id = "a" * 32
    url = "https://www.notion.so/My-Doc-" + page_id + "?pvs=4"
    assert notion_tools._extract_id(url) == page_id


def test_extract_id_from_dashed_uuid():
    dashed = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
    assert notion_tools._extract_id(dashed) == "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"


def test_extract_id_raw_non_id_passthrough():
    assert notion_tools._extract_id("parent") == "parent"


def test_extract_id_from_url_with_trailing_slash():
    page_id = "b" * 32
    url = "https://www.notion.so/My-Doc-" + page_id + "/"
    assert notion_tools._extract_id(url) == page_id


def test_extract_id_from_url_with_fragment():
    page_id = "c" * 32
    url = "https://www.notion.so/My-Doc-" + page_id + "#frag"
    assert notion_tools._extract_id(url) == page_id


# ── NotionCreatePage / NotionAppend: 100-block cap ──────────────────────────────

def test_create_page_caps_children_at_100_blocks(token, monkeypatch):
    captured = {}

    def fake_post(url, *a, **k):
        captured["json"] = k.get("json")
        return _Resp(200, {"url": "https://notion.so/new"})

    monkeypatch.setattr(notion_tools.httpx, "post", fake_post)
    long_content = "\n".join(f"line {i}" for i in range(200))
    notion_tools.NotionCreatePage(parent_id="parent", title="T",
                                  content=long_content).run()
    assert len(captured["json"]["children"]) == 100


def test_append_caps_children_at_100_blocks(token, monkeypatch):
    captured = {}

    def fake_patch(url, *a, **k):
        captured["json"] = k.get("json")
        return _Resp(200, {"results": []})

    monkeypatch.setattr(notion_tools.httpx, "patch", fake_patch)
    long_content = "\n".join(f"line {i}" for i in range(200))
    notion_tools.NotionAppend(page_id="pg", content=long_content).run()
    assert len(captured["json"]["children"]) == 100


# ── NotionRead: honesty when the body fetch fails ───────────────────────────────

def test_read_reports_body_fetch_failure(token, monkeypatch):
    def fake_get(url, *a, **k):
        if "/children" in url:
            return _Resp(500)
        return _Resp(200, {"properties": {"title": {"type": "title",
                     "title": [{"plain_text": "Doc"}]}}})

    monkeypatch.setattr(notion_tools.httpx, "get", fake_get)
    out = notion_tools.NotionRead(page="pg").run()
    assert "Doc" in out
    assert "could not read page body: HTTP 500" in out
