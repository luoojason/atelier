"""The zero-cost sample-run deliverable route (Round-2 P1 first win)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import lite_server  # noqa: E402


@pytest.fixture
def client():
    return TestClient(lite_server.app)


@pytest.fixture(autouse=True)
def _workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("ATELIER_WORKSPACE", str(tmp_path / "ws"))
    monkeypatch.delenv("ATELIER_TOKEN", raising=False)


def test_demo_sample_writes_the_deliverable(client, tmp_path):
    resp = client.post("/demo/sample")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["path"] == "sample-run/five-desk-plants.md"
    target = tmp_path / "ws" / "sample-run" / "five-desk-plants.md"
    assert target.is_file()
    text = target.read_text(encoding="utf-8")
    # the honesty labels ship inside the deliverable itself
    assert "sample deliverable" in text
    assert "No agents, models, or web" in text.replace("\n", " ")


def test_demo_sample_is_idempotent(client, tmp_path):
    assert client.post("/demo/sample").status_code == 200
    assert client.post("/demo/sample").status_code == 200  # overwrite, no error


def test_demo_sample_is_token_gated(client, monkeypatch):
    monkeypatch.setenv("ATELIER_TOKEN", "sekret")
    assert client.post("/demo/sample").status_code == 403
    assert (
        client.post("/demo/sample", headers={"X-Atelier-Token": "sekret"}).status_code
        == 200
    )


def test_deliverable_is_served_by_workspace_raw(client):
    client.post("/demo/sample")
    resp = client.get("/workspace/raw?path=sample-run/five-desk-plants.md")
    assert resp.status_code == 200
    assert b"Five desk plants" in resp.content
