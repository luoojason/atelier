"""Tests for lite_server's /versions* routes via fastapi TestClient — no live
server, and NO real versions store: the store boundary (_versions_store) is
monkeypatched with a recording stub, so these tests pin the ROUTE contract
(shapes, clamping, path validation, id validation, token gating, never-500)
independently of shared_tools/versions_store.py's own suite.

The contract under test (frozen R15):
  * GET  /versions?limit=N -> {"notes":[store rows + "display"]}, limit
    clamped 1..200; display = vault-relative path when inside the vault,
    else the basename;
  * GET  /versions/list?path= -> {"path","versions"}; a path that does not
    resolve inside the vault root degrades to {"path":"","versions":[]}
    without the hostile path ever being echoed back;
  * GET  /versions/content?path=&id= -> {"content": str|null}; the id must
    match ^[a-f0-9]{8,64}$ or content is null and the store is never touched;
  * POST /versions/restore {"path","id"} -> {"ok": bool}, token-gated by the
    middleware like every other mutating route;
  * every route returns its empty shape on any store failure — never a 500.

Needs the extension venv:

    .venv-ext/bin/python -m pytest -q tests/test_versions_routes.py
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


VID = "a" * 40  # a well-formed lowercase-hex version id


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def vault(monkeypatch, tmp_path):
    """A tmp vault root, with the token gate off by default."""
    root = tmp_path / "vault"
    (root / "Projects").mkdir(parents=True)
    monkeypatch.setenv("OBSIDIAN_VAULT", str(root))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)
    return root


@pytest.fixture
def client():
    return TestClient(lite_server.app)


class _StubStore:
    """Recording stand-in for shared_tools.versions_store (frozen API only)."""

    def __init__(self):
        self.calls = []
        self.notes = []
        self.versions = []
        self.content = None
        self.restore_ok = True

    def list_notes(self, limit=50):
        self.calls.append(("list_notes", limit))
        return self.notes

    def list_versions(self, note_path):
        self.calls.append(("list_versions", note_path))
        return self.versions

    def read_version(self, note_path, version_id):
        self.calls.append(("read_version", note_path, version_id))
        return self.content

    def restore(self, note_path, version_id):
        self.calls.append(("restore", note_path, version_id))
        return self.restore_ok


@pytest.fixture
def store(monkeypatch):
    """Swap the call-time store import for the recording stub."""
    stub = _StubStore()
    monkeypatch.setattr(lite_server, "_versions_store", lambda: stub)
    return stub


def _install_broken_store(monkeypatch, exc):
    """A store boundary that fails outright — same code path as a missing or
    broken shared_tools/versions_store module (the lazy import raising)."""

    def _boom():
        raise exc

    monkeypatch.setattr(lite_server, "_versions_store", _boom)


# ── GET /versions ────────────────────────────────────────────────────────────

def test_versions_shape_and_display(vault, store, client):
    inside = str(vault / "Projects" / "Iris.md")
    outside = "/etc/hosts"
    store.notes = [
        {"path": inside, "versions": 3, "latest_ts": "2026-07-02T10:00:00"},
        {"path": outside, "versions": 1, "latest_ts": "2026-07-01T09:00:00"},
    ]
    resp = client.get("/versions")
    assert resp.status_code == 200
    notes = resp.json()["notes"]
    # store fields pass through untouched; display is added
    assert notes[0]["path"] == inside
    assert notes[0]["versions"] == 3
    assert notes[0]["latest_ts"] == "2026-07-02T10:00:00"
    assert notes[0]["display"] == "Projects/Iris.md"
    # a note outside the vault displays as its basename only
    assert notes[1]["display"] == "hosts"


@pytest.mark.parametrize(
    "query,expected",
    [
        ("?limit=999", 200),  # clamp high
        ("?limit=0", 1),      # clamp low
        ("?limit=-5", 1),
        ("?limit=7", 7),
        ("", 50),             # default
    ],
)
def test_versions_limit_clamped(vault, store, client, query, expected):
    client.get(f"/versions{query}")
    assert store.calls == [("list_notes", expected)]


def test_versions_tolerates_junk_rows(vault, store, client):
    good = {"path": str(vault / "a.md"), "versions": 1, "latest_ts": "t"}
    store.notes = ["garbage", None, 42, good]
    notes = client.get("/versions").json()["notes"]
    assert len(notes) == 1
    assert notes[0]["display"] == "a.md"


def test_versions_missing_path_field_degrades_to_empty_name(vault, store, client):
    store.notes = [{"versions": 1, "latest_ts": "t"}]
    resp = client.get("/versions")
    assert resp.status_code == 200  # a malformed row still never 500s


def test_versions_store_failure_never_500(vault, monkeypatch, client):
    _install_broken_store(monkeypatch, RuntimeError("store exploded"))
    resp = client.get("/versions")
    assert resp.status_code == 200
    assert resp.json() == {"notes": []}


def test_versions_store_missing_module_never_500(vault, monkeypatch, client):
    _install_broken_store(monkeypatch, ImportError("no versions_store"))
    assert client.get("/versions").json() == {"notes": []}


# ── GET /versions/list ───────────────────────────────────────────────────────

def test_versions_list_valid_path(vault, store, client):
    note = str(vault / "Projects" / "Iris.md")
    store.versions = [
        {"id": VID, "ts": "2026-07-02T10:00:00", "source": "overwrite",
         "label": "", "size": 10},
    ]
    body = client.get("/versions/list", params={"path": note}).json()
    assert body == {"path": note, "versions": store.versions}
    assert store.calls == [("list_versions", note)]


def test_versions_list_rejects_outside_vault(vault, store, client):
    resp = client.get("/versions/list", params={"path": "/etc/hosts"})
    assert resp.status_code == 200
    assert resp.json() == {"path": "", "versions": []}
    assert "/etc/hosts" not in resp.text  # hostile path never echoed
    assert store.calls == []              # and never reaches the store


def test_versions_list_rejects_traversal(vault, store, client):
    hostile = str(vault) + "/../outside.md"  # resolves out of the vault
    resp = client.get("/versions/list", params={"path": hostile})
    assert resp.json() == {"path": "", "versions": []}
    assert store.calls == []


def test_versions_list_rejects_empty_path(vault, store, client):
    assert client.get("/versions/list").json() == {"path": "", "versions": []}
    assert store.calls == []


def test_versions_list_store_failure_never_500(vault, monkeypatch, client):
    _install_broken_store(monkeypatch, RuntimeError("boom"))
    resp = client.get("/versions/list", params={"path": "/anywhere"})
    assert resp.status_code == 200
    assert resp.json() == {"path": "", "versions": []}


# ── GET /versions/content ────────────────────────────────────────────────────

def test_versions_content_happy(vault, store, client):
    note = str(vault / "n.md")
    store.content = "old body"
    body = client.get(
        "/versions/content", params={"path": note, "id": VID}
    ).json()
    assert body == {"content": "old body"}
    assert store.calls == [("read_version", note, VID)]


def test_versions_content_unknown_version_is_null(vault, store, client):
    note = str(vault / "n.md")
    store.content = None
    body = client.get(
        "/versions/content", params={"path": note, "id": VID}
    ).json()
    assert body == {"content": None}


@pytest.mark.parametrize(
    "bad_id",
    [
        "",             # empty
        "a" * 7,        # under the 8-char floor
        "a" * 65,       # over the 64-char ceiling
        "A" * 40,       # uppercase hex is not in the alphabet
        "g" * 40,       # not hex at all
        "a" * 39 + "\n",  # trailing newline must not sneak past
        "../../etc",    # traversal junk
    ],
)
def test_versions_content_bad_id_is_null_and_never_hits_store(
    vault, store, client, bad_id
):
    note = str(vault / "n.md")
    body = client.get(
        "/versions/content", params={"path": note, "id": bad_id}
    ).json()
    assert body == {"content": None}
    assert store.calls == []


def test_versions_content_outside_vault_is_null(vault, store, client):
    body = client.get(
        "/versions/content", params={"path": "/etc/hosts", "id": VID}
    ).json()
    assert body == {"content": None}
    assert store.calls == []


def test_versions_content_store_failure_never_500(vault, monkeypatch, client):
    _install_broken_store(monkeypatch, RuntimeError("boom"))
    resp = client.get("/versions/content", params={"path": "/x", "id": VID})
    assert resp.status_code == 200
    assert resp.json() == {"content": None}


# ── POST /versions/restore ───────────────────────────────────────────────────

def test_restore_happy_path(vault, store, client):
    note = str(vault / "n.md")
    resp = client.post("/versions/restore", json={"path": note, "id": VID})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert store.calls == [("restore", note, VID)]


def test_restore_store_says_no(vault, store, client):
    store.restore_ok = False
    note = str(vault / "n.md")
    resp = client.post("/versions/restore", json={"path": note, "id": VID})
    assert resp.json() == {"ok": False}


def test_restore_outside_vault_refused_before_store(vault, store, client):
    resp = client.post(
        "/versions/restore", json={"path": "/etc/hosts", "id": VID}
    )
    assert resp.json() == {"ok": False}
    assert store.calls == []


def test_restore_bad_id_refused_before_store(vault, store, client):
    note = str(vault / "n.md")
    resp = client.post("/versions/restore", json={"path": note, "id": "ZZZ"})
    assert resp.json() == {"ok": False}
    assert store.calls == []


def test_restore_empty_body_fields(vault, store, client):
    assert client.post("/versions/restore", json={}).json() == {"ok": False}
    assert store.calls == []


def test_restore_store_failure_never_500(vault, monkeypatch, client):
    _install_broken_store(monkeypatch, RuntimeError("boom"))
    resp = client.post("/versions/restore", json={"path": "/x", "id": VID})
    assert resp.status_code == 200
    assert resp.json() == {"ok": False}


# ── token gate (middleware is method-based: POST gated, GETs open) ───────────

def test_restore_is_token_gated(vault, store, client, monkeypatch):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    note = str(vault / "n.md")

    resp = client.post("/versions/restore", json={"path": note, "id": VID})
    assert resp.status_code == 403
    assert store.calls == []  # rejected before the handler ran

    resp = client.post(
        "/versions/restore",
        json={"path": note, "id": VID},
        headers={"X-Atelier-Token": "sekret"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert store.calls == [("restore", note, VID)]


def test_version_reads_gated_with_token_set(vault, store, client, monkeypatch):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    hdr = {"X-Atelier-Token": "sekret"}
    for path in ("/versions", "/versions/list", "/versions/content"):
        assert client.get(path).status_code == 403
        assert client.get(path, headers=hdr).status_code == 200
