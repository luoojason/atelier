"""HTTP client for firing prompts at the OpenSwarm FastAPI agency endpoint.

The real route and body shape were determined by inspecting the installed
``agency_swarm.integrations.fastapi`` server used by ``server.py``:

    POST  {base_url}/{agency}/get_response
    body: {"message": "<prompt>", "recipient_agent": "<agent name>" | omitted}
    auth: Authorization: Bearer <APP_TOKEN>   (only when the server has APP_TOKEN set)
    resp: {"response": <final_output>, "new_messages": [...], "usage": {...}}

``build_request`` is a pure function (no network) so it is fully unit-testable.
``send`` is a thin wrapper that performs the POST with an injectable client, so
tests can pass a fake and never touch the network.
"""

from __future__ import annotations

import os
from typing import Any, Optional

# The path segment the agency server mounts its routes under. The server
# normalizes the agency name by replacing spaces with underscores (hyphens are
# preserved), so "open-swarm" stays "open-swarm".
RESPONSE_ROUTE = "get_response"


def build_request(
    base_url: str,
    agency: str,
    prompt: str,
    agent: Optional[str] = None,
) -> dict:
    """Build the ``{"url": ..., "json": ...}`` for the agency POST.

    >>> build_request("http://localhost:8080/", "open-swarm", "hi")
    {'url': 'http://localhost:8080/open-swarm/get_response', 'json': {'message': 'hi'}}
    >>> build_request("http://h:8080", "open-swarm", "hi", "orchestrator")['json']
    {'message': 'hi', 'recipient_agent': 'orchestrator'}
    """
    if not base_url:
        raise ValueError("base_url is required")
    if not agency:
        raise ValueError("agency is required")
    if not prompt:
        raise ValueError("prompt is required")

    base = base_url.rstrip("/")
    agency_name = agency.replace(" ", "_")
    url = f"{base}/{agency_name}/{RESPONSE_ROUTE}"

    body: dict[str, Any] = {"message": prompt}
    if agent:
        body["recipient_agent"] = agent

    return {"url": url, "json": body}


def _auth_headers(app_token: Optional[str]) -> dict:
    """Auth headers: Bearer when configured, plus the Atelier shared secret.

    ATELIER_TOKEN is minted per launch by the desktop app's main.js and passed
    to this daemon via spawn env; the lite backend requires it on mutating
    routes (this client's POST). Unset (standalone daemon against a token-less
    backend) adds nothing, preserving the historical empty-headers behavior.
    """
    headers: dict[str, str] = {}
    if app_token:
        headers["Authorization"] = f"Bearer {app_token}"
    atelier_token = os.getenv("ATELIER_TOKEN")
    if atelier_token:
        headers["X-Atelier-Token"] = atelier_token
    return headers


def summarize_response(status_code: int, payload: Any) -> dict:
    """Turn a raw HTTP status + decoded body into a compact result dict.

    Pure function so callers/tests can format results without a live response.
    """
    result: dict[str, Any] = {
        "status_code": status_code,
        "ok": 200 <= status_code < 300,
    }
    if isinstance(payload, dict):
        if "response" in payload:
            result["response"] = payload["response"]
        if "error" in payload:
            result["error"] = payload["error"]
        usage = payload.get("usage")
        if isinstance(usage, dict):
            if "total_tokens" in usage:
                result["total_tokens"] = usage["total_tokens"]
            # Keep a cost figure when the usage dict carries one, under whatever
            # key the provider used. Optional: absent on most agency responses.
            for cost_key in ("cost", "cost_usd", "total_cost"):
                if cost_key in usage:
                    result["cost"] = usage[cost_key]
                    break
    elif payload is not None:
        result["text"] = str(payload)[:500]
    return result


def send(
    base_url: str,
    agency: str,
    prompt: str,
    agent: Optional[str] = None,
    app_token: Optional[str] = None,
    timeout: float = 300.0,
    client: Any = None,
) -> dict:
    """POST the prompt to the agency and return a compact result dict.

    ``client`` is any object exposing ``.post(url, json=..., headers=...)`` that
    returns a response with ``.status_code`` and (optionally) ``.json()`` /
    ``.text``. When omitted, a short-lived ``httpx.Client`` is created. Tests
    inject a fake client so no network access is required.
    """
    request = build_request(base_url, agency, prompt, agent)
    headers = _auth_headers(app_token)

    owns_client = client is None
    if owns_client:
        import httpx  # imported lazily so the module loads without httpx

        client = httpx.Client(timeout=timeout)

    try:
        response = client.post(request["url"], json=request["json"], headers=headers)
    finally:
        if owns_client:
            client.close()

    status_code = getattr(response, "status_code", 0)
    payload: Any = None
    json_method = getattr(response, "json", None)
    if callable(json_method):
        try:
            payload = json_method()
        except Exception:
            payload = getattr(response, "text", None)
    else:
        payload = getattr(response, "text", None)

    result = summarize_response(status_code, payload)
    result["url"] = request["url"]
    return result
