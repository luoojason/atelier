"""External-agent connectors — bridge Atelier to agents that run OUTSIDE its own
backend (Iris, Hermes, OpenClaw, or any OpenAI-compatible chat endpoint).

An "external agent" is a user-configured remote endpoint. Atelier stores its
connection details (``~/.atelier/external_agents.json``, 0600 because it can
hold an API key) and forwards chat turns to it, so the agent appears on the
canvas as a first-class chat card while actually running on its own service
(and guiding its own sub-agents there).

Design notes
------------
* The store mirrors ``save_settings`` — an atomic 0600 write (a key never sits
  in a looser-permissioned tmp file, not even between create and write).
* A stored key NEVER leaves this module in a public view: ``sanitize`` returns
  only ``key_present`` + a last-4 ``key_hint`` (same rule as the Anthropic key).
* Forwarding is USER-initiated only (the card POSTs, token-gated by the server
  middleware) — no orchestra tool exposes it to an agent — so it is not in the
  agent-initiated SSRF class. We still validate the URL scheme and DO allow
  private / loopback hosts on purpose: a user's own Iris / Ollama frequently
  lives on localhost or the LAN, and blocking those would break the feature.
* One adapter today, ``openai`` (the de-facto standard Iris/Hermes/OpenClaw and
  most agent servers can speak): POST ``{base}/chat/completions`` with
  ``{model, messages}`` and read ``choices[0].message.content``. ``adapter`` is
  a field so more shapes can be added without a schema change.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from urllib.parse import urlparse, urlsplit, urlunsplit

import httpx  # already bundled (used by shared_tools/notion_tools)

ADAPTERS = ("openai",)
_DEFAULT_ADAPTER = "openai"

# Models KNOWN not to support user tool-calling (search-grounded answer models,
# or reasoning-only models that ignore/reject a tools field). Advisory only: the
# external tool loop's typed-error fallback is the real gate. This list lets the
# UI grey the tools toggle up front and lets the agent_message route skip
# straight to plain chat with a note. Kept conservative on substrings so a
# tool-capable model is never mislabeled (e.g. no bare "llama3" — the Ollama
# preset default is changed to a tool-capable model instead).
_INCAPABLE_SUBSTRINGS = ("sonar",)
_INCAPABLE_EXACT = frozenset({"deepseek-reasoner", "deepseek-r1"})


def model_tools_capable(model: str) -> bool:
    """False for a model known not to support user tool-calling; True when
    capable or unknown (blank/custom names default to capable so the runtime
    fallback decides). Substring match stays narrow to avoid false negatives."""
    m = (model or "").strip().lower()
    if not m:
        return True
    if m in _INCAPABLE_EXACT:
        return False
    return not any(s in m for s in _INCAPABLE_SUBSTRINGS)
_TIMEOUT = 90.0
_MAX_HISTORY = 40           # trailing turns forwarded (a stateless endpoint's context)
_MAX_MSG_CHARS = 200_000    # matches the session message ceiling
_NAME_MAX = 80
_MODEL_MAX = 120


def _store_path() -> Path:
    return Path(
        os.getenv("ATELIER_EXTERNAL_AGENTS_PATH") or "~/.atelier/external_agents.json"
    ).expanduser()


def load_agents() -> list[dict]:
    """The persisted external agents, degraded to [] on any failure.

    Each stored record: {id, name, base_url, api_key, model, adapter}. Malformed
    entries (missing id/name/base_url, or a bad scheme) are dropped so a corrupt
    file can never crash the server or surface a half-agent.
    """
    try:
        data = json.loads(_store_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    raw = data.get("agents") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        aid = str(item.get("id") or "")
        name = str(item.get("name") or "").strip()
        base_url = str(item.get("base_url") or "").strip()
        if not aid or aid in seen or not name or not _url_ok(base_url):
            continue
        seen.add(aid)
        adapter = item.get("adapter")
        out.append(
            {
                "id": aid,
                "name": name[:_NAME_MAX],
                "base_url": base_url,
                "api_key": str(item.get("api_key") or ""),
                "model": str(item.get("model") or "").strip()[:_MODEL_MAX],
                "adapter": adapter if adapter in ADAPTERS else _DEFAULT_ADAPTER,
                "tools_enabled": bool(item.get("tools_enabled")),
            }
        )
    return out


def save_agents(agents: list[dict]) -> None:
    """Atomic 0600 write (mirrors save_settings — the tmp is created 0600 so a
    stored key is never observable with looser perms, not even mid-write)."""
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        os.fchmod(fd, 0o600)
        f.write(json.dumps({"agents": agents}, indent=2))
    os.replace(tmp, path)


def _url_ok(url: str) -> bool:
    """A syntactically valid http/https URL with a host. Reach is user-granted
    (the user typed their own agent's address), so private/loopback are allowed
    on purpose — only the scheme and a present host are required. Control/
    whitespace characters are rejected: urlparse silently tolerates some (a tab
    in the host) and httpx.URL later raises InvalidURL on others, so a stored
    base_url must be free of them up front."""
    if any(ord(c) < 0x20 or ord(c) == 0x7f for c in url):
        return False
    try:
        p = urlparse(url)
    except ValueError:
        return False
    return p.scheme in ("http", "https") and bool(p.netloc)


def _key_hint(key: str) -> str:
    return "…" + key[-4:] if key else ""


def sanitize(agent: dict) -> dict:
    """The only public view of an agent — the raw api_key never appears, only
    presence + a last-4 hint (same contract as the Anthropic key in /config)."""
    key = agent.get("api_key") or ""
    return {
        "id": agent["id"],
        "name": agent["name"],
        "base_url": agent["base_url"],
        "model": agent.get("model") or "",
        "adapter": agent.get("adapter") or _DEFAULT_ADAPTER,
        "key_present": bool(key),
        "key_hint": _key_hint(key),
        "tools_enabled": bool(agent.get("tools_enabled")),
        "tools_capable": model_tools_capable(agent.get("model") or ""),
    }


def list_public() -> list[dict]:
    return [sanitize(a) for a in load_agents()]


def upsert(payload: dict) -> tuple[bool, str | dict]:
    """Create or update one agent. Returns (True, sanitized) or (False, reason).

    An existing id updates in place; a blank/absent api_key on an UPDATE keeps
    the stored key (so editing a name never wipes the key), while on a CREATE it
    just means "no key". Passing api_key="" explicitly on update also keeps it —
    removal is a dedicated concern (delete the agent) rather than an empty save.
    """
    if not isinstance(payload, dict):
        return False, "bad request"
    name = str(payload.get("name") or "").strip()
    if not name:
        return False, "name is required"
    base_url = str(payload.get("base_url") or "").strip()
    if not _url_ok(base_url):
        return False, "base_url must be an http(s) URL"
    adapter = payload.get("adapter") or _DEFAULT_ADAPTER
    if adapter not in ADAPTERS:
        return False, "unknown adapter"

    agents = load_agents()
    aid = str(payload.get("id") or "")
    existing = next((a for a in agents if a["id"] == aid), None) if aid else None
    if existing is None:
        aid = uuid.uuid4().hex
    # key: a provided non-empty value wins; otherwise keep the existing key.
    provided_key = payload.get("api_key")
    if provided_key:
        api_key = str(provided_key)
    else:
        api_key = existing.get("api_key", "") if existing else ""

    # tools_enabled: an omitted field on an UPDATE keeps the stored value (so an
    # unrelated edit never silently disables tools); present -> its truthiness.
    te = payload.get("tools_enabled")
    if te is None:
        tools_enabled = bool(existing.get("tools_enabled")) if existing else False
    else:
        tools_enabled = bool(te)

    record = {
        "id": aid,
        "name": name[:_NAME_MAX],
        "base_url": base_url,
        "api_key": api_key,
        "model": str(payload.get("model") or "").strip()[:_MODEL_MAX],
        "adapter": adapter,
        "tools_enabled": tools_enabled,
    }
    if existing is not None:
        agents = [record if a["id"] == aid else a for a in agents]
    else:
        agents.append(record)
    save_agents(agents)
    return True, sanitize(record)


def remove(agent_id: str) -> bool:
    agents = load_agents()
    kept = [a for a in agents if a["id"] != agent_id]
    if len(kept) == len(agents):
        return False
    save_agents(kept)
    return True


def _build_messages(history, message: str) -> list[dict]:
    """Compose the OpenAI-shaped message list: sanitized trailing history plus
    the new user turn. History entries with an unknown role or non-string
    content are dropped rather than forwarded raw."""
    msgs: list[dict] = []
    if isinstance(history, list):
        for h in history[-_MAX_HISTORY:]:
            if not isinstance(h, dict):
                continue
            role = h.get("role")
            content = h.get("content")
            if role in ("user", "assistant", "system") and isinstance(content, str):
                msgs.append({"role": role, "content": content[:_MAX_MSG_CHARS]})
    msgs.append({"role": "user", "content": message[:_MAX_MSG_CHARS]})
    return msgs


def _completions_url(base_url: str) -> str:
    """Append '/chat/completions' to the PATH only, preserving any query string
    or fragment (splitting on the raw string would corrupt a '?' into the path)."""
    parts = urlsplit(base_url)
    path = parts.path.rstrip("/")
    if not path.endswith("/chat/completions"):
        path = path + "/chat/completions"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


async def forward(agent_id: str, message: str, history=None) -> tuple[bool, str]:
    """Forward one turn to the external agent. Returns (ok, text).

    Never raises and never echoes the api_key: any transport/HTTP/parse failure
    becomes (False, "<human reason>"). The 'openai' adapter POSTs
    {base}/chat/completions with {model, messages} and reads the first choice.
    """
    agent = next((a for a in load_agents() if a["id"] == agent_id), None)
    if agent is None:
        return False, "This external agent is no longer configured."
    if not isinstance(message, str) or not message.strip():
        return False, "empty message"

    messages = _build_messages(history, message)
    headers = {"Content-Type": "application/json"}
    if agent.get("api_key"):
        headers["Authorization"] = "Bearer " + agent["api_key"]
    body = {"messages": messages}
    if agent.get("model"):
        body["model"] = agent["model"]

    url = _completions_url(agent["base_url"])
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, headers=headers, json=body)
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        # connect/read timeouts, DNS, refused, or a malformed URL that slipped
        # past _url_ok — InvalidURL is NOT an httpx.HTTPError, so name it
        # explicitly. Never raises (route contract) and never leaks the key.
        return False, "Could not reach the external agent (connection failed or timed out)."
    if resp.status_code >= 400:
        return False, f"The external agent returned HTTP {resp.status_code}."
    try:
        data = resp.json()
    except ValueError:
        return False, "The external agent returned a non-JSON response."
    text = _extract_openai_text(data)
    if text is None:
        return False, "The external agent's response had no message content."
    return True, text


def _extract_openai_text(data) -> str | None:
    if not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            msg = first.get("message")
            if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                return msg["content"]
            # some servers stream-collapse to a top-level 'text'
            if isinstance(first.get("text"), str):
                return first["text"]
    # tolerate a couple of common non-OpenAI shapes agents sometimes return
    for key in ("response", "content", "message"):
        v = data.get(key)
        if isinstance(v, str):
            return v
    return None
