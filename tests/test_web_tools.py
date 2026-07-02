"""Tests for shared_tools/web_tools.py (WebSearch, WebFetch) — the keyless
DuckDuckGo-lite tools that give Atelier real web access without any API key.

Same boundary-mock style as the rest of the suite: httpx.post/httpx.get are
monkeypatched with a fake response object, so no test ever hits the live
network. The contract under test:
  * WebSearch POSTs to https://lite.duckduckgo.com/lite/ with the query,
    parses the lite HTML result rows into title + url (+ snippet), and
    returns a readable numbered list capped at max_results;
  * WebSearch returns an explicit "WebSearch failed: ..." string (never a
    silent empty string or fabricated data) on a non-200 response, a raised
    exception, or zero parsed results;
  * WebFetch GETs a url, strips <script>/<style> and tags to readable text,
    collapses whitespace, and caps the result to ~6000 chars;
  * WebFetch rejects non-http(s) urls before making any request, and returns
    an explicit "WebFetch failed: ..." string on a non-200 response or a
    raised exception;
  * both tools are wired into lite_server's LIGHT_TOOLS, so
    build_options().allowed_tools includes mcp__atelier__WebSearch and
    mcp__atelier__WebFetch.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_web_tools.py
"""

import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from shared_tools.web_tools import WebFetch, WebSearch  # noqa: E402

# A trimmed but structurally faithful sample of lite.duckduckgo.com/lite/'s
# result HTML (captured live for the query "dog images"): result rows are
# `<a ... class='result-link' href="...">title</a>` followed by a sibling
# `<td class='result-snippet'>...</td>`, plus one internal duckduckgo.com
# link mixed in to prove internal links get skipped.
_SAMPLE_LITE_HTML = """
<html><body><table>
<tr>
  <td valign="top">1.&nbsp;</td>
  <td><a rel="nofollow" href="https://www.pexels.com/search/dog/" class='result-link'>4,000+ Best Dog Photos &middot; 100% Free Download - Pexels</a></td>
</tr>
<tr>
  <td>&nbsp;</td>
  <td class='result-snippet'>Download and use 4,000+ <b>Dog</b> stock photos for free.</td>
</tr>
<tr>
  <td valign="top">2.&nbsp;</td>
  <td><a rel="nofollow" href="https://pixabay.com/images/search/dog/" class='result-link'>50,000+ Free Dog &amp; Animal Images - Pixabay</a></td>
</tr>
<tr>
  <td>&nbsp;</td>
  <td class='result-snippet'>55,731 Free <b>images</b> of <b>Dog</b>.</td>
</tr>
<tr>
  <td valign="top">3.&nbsp;</td>
  <td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad=1" class='result-link'>Sponsored internal link</a></td>
</tr>
</table></body></html>
"""

_EMPTY_LITE_HTML = "<html><body><table></table></body></html>"


class _FakeResponse:
    def __init__(self, status_code=200, text=""):
        self.status_code = status_code
        self.text = text


def test_websearch_parses_titles_urls_and_snippets(monkeypatch):
    calls = {}

    def fake_post(url, data=None, headers=None, timeout=None, follow_redirects=None):
        calls["url"] = url
        calls["data"] = data
        calls["headers"] = headers
        return _FakeResponse(200, _SAMPLE_LITE_HTML)

    monkeypatch.setattr("shared_tools.web_tools.httpx.post", fake_post)

    result = WebSearch(query="dog images", max_results=6).run()

    assert calls["url"] == "https://lite.duckduckgo.com/lite/"
    assert calls["data"] == {"q": "dog images"}
    assert "Mozilla" in calls["headers"]["User-Agent"]

    assert "Pexels" in result
    assert "https://www.pexels.com/search/dog/" in result
    assert "Pixabay" in result
    assert "https://pixabay.com/images/search/dog/" in result
    assert "Download and use 4,000+ Dog stock photos" in result
    # internal duckduckgo.com links must never surface as a result
    assert "duckduckgo.com/y.js" not in result


def test_websearch_respects_max_results(monkeypatch):
    def fake_post(url, data=None, headers=None, timeout=None, follow_redirects=None):
        return _FakeResponse(200, _SAMPLE_LITE_HTML)

    monkeypatch.setattr("shared_tools.web_tools.httpx.post", fake_post)

    result = WebSearch(query="dog images", max_results=1).run()
    assert "Pexels" in result
    assert "Pixabay" not in result


def test_websearch_non_200_returns_explicit_error(monkeypatch):
    def fake_post(url, data=None, headers=None, timeout=None, follow_redirects=None):
        return _FakeResponse(503, "service unavailable")

    monkeypatch.setattr("shared_tools.web_tools.httpx.post", fake_post)

    result = WebSearch(query="dog images").run()
    assert result.startswith("WebSearch failed:")
    assert "503" in result


def test_websearch_exception_returns_explicit_error(monkeypatch):
    def fake_post(url, data=None, headers=None, timeout=None, follow_redirects=None):
        raise OSError("network unreachable")

    monkeypatch.setattr("shared_tools.web_tools.httpx.post", fake_post)

    result = WebSearch(query="dog images").run()
    assert result.startswith("WebSearch failed:")
    assert "network unreachable" in result


def test_websearch_no_results_returns_explicit_error(monkeypatch):
    def fake_post(url, data=None, headers=None, timeout=None, follow_redirects=None):
        return _FakeResponse(200, _EMPTY_LITE_HTML)

    monkeypatch.setattr("shared_tools.web_tools.httpx.post", fake_post)

    result = WebSearch(query="asdkjhaskjdhaskjdh").run()
    assert result.startswith("WebSearch failed:")
    assert result.strip()  # never a silent empty string


def test_webfetch_strips_tags_and_collapses_whitespace(monkeypatch):
    html_body = (
        "<html><head><style>body{color:red}</style>"
        "<script>alert('x')</script></head>"
        "<body>\n\n  <h1>Title</h1>  <p>Hello   world.\n\nSecond   line.</p>"
        "</body></html>"
    )

    def fake_get(url, headers=None, timeout=None, follow_redirects=None):
        return _FakeResponse(200, html_body)

    monkeypatch.setattr("shared_tools.web_tools.httpx.get", fake_get)

    result = WebFetch(url="https://example.com/page").run()
    assert "alert" not in result
    assert "color:red" not in result
    assert "<" not in result
    assert "Title" in result
    assert "Hello world." in result
    assert "Second line." in result


def test_webfetch_caps_length(monkeypatch):
    big_html = "<p>" + ("word " * 5000) + "</p>"

    def fake_get(url, headers=None, timeout=None, follow_redirects=None):
        return _FakeResponse(200, big_html)

    monkeypatch.setattr("shared_tools.web_tools.httpx.get", fake_get)

    result = WebFetch(url="https://example.com/big").run()
    assert len(result) <= 6000


def test_webfetch_non_200_returns_explicit_error(monkeypatch):
    def fake_get(url, headers=None, timeout=None, follow_redirects=None):
        return _FakeResponse(404, "not found")

    monkeypatch.setattr("shared_tools.web_tools.httpx.get", fake_get)

    result = WebFetch(url="https://example.com/missing").run()
    assert result.startswith("WebFetch failed:")
    assert "404" in result


def test_webfetch_exception_returns_explicit_error(monkeypatch):
    def fake_get(url, headers=None, timeout=None, follow_redirects=None):
        raise OSError("connection reset")

    monkeypatch.setattr("shared_tools.web_tools.httpx.get", fake_get)

    result = WebFetch(url="https://example.com/x").run()
    assert result.startswith("WebFetch failed:")
    assert "connection reset" in result


@pytest.mark.parametrize(
    "bad_url",
    ["ftp://example.com/file", "file:///etc/passwd", "javascript:alert(1)", "example.com/no-scheme"],
)
def test_webfetch_rejects_non_http_schemes(monkeypatch, bad_url):
    def fake_get(*a, **k):
        raise AssertionError("must not make a request for a rejected scheme")

    monkeypatch.setattr("shared_tools.web_tools.httpx.get", fake_get)

    result = WebFetch(url=bad_url).run()
    assert result.startswith("WebFetch failed:")


def test_web_tools_are_wired_into_atelier_allowed_tools():
    pytest.importorskip("claude_agent_sdk")
    import lite_server

    allowed = lite_server.build_options().allowed_tools
    assert "mcp__atelier__WebSearch" in allowed
    assert "mcp__atelier__WebFetch" in allowed
