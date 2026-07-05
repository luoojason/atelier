"""Per-provider daily spend ledger + the mandatory default cap.

The launch review's #3 blocker: a runaway loop on a metered, bring-your-own-key
provider can drain that key with nothing standing in the way. This module is
the standing thing: every metered call in the external lane records its cost
here, and the lane refuses to start a call once today's spend for that provider
reaches the cap.

Design decisions:
  * The cap is PER PROVIDER HOST, PER LOCAL DAY, default $5, mandatory —
    settings key "spend_cap_usd" can raise it or set 0 to disable, but absent
    settings mean $5, not unlimited.
  * "Metered" means a non-loopback host. A user's own local server
    (Ollama/LM Studio on 127.0.0.1) is free and never accounted. Remote
    endpoints whose models LiteLLM cannot price record $0 — a personal Iris or
    Hermes box therefore never trips the cap; only priceable commercial models
    accrue spend. Under-counting an exotic paid model is the accepted v1
    trade-off; the common drain path (OpenAI/Gemini/Groq/... via a real key)
    is priced.
  * The ledger is a tiny JSON file (env ATELIER_SPEND_PATH, default
    ~/.atelier/spend.json), atomic-written, keyed by one local date — a new
    day starts a fresh ledger. Corrupt or unreadable ledgers reset to empty
    rather than raising: the cap is a guardrail, not a payment system.
"""

from __future__ import annotations

import datetime
import ipaddress
import json
import os
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_CAP_USD = 5.0


def _read_settings() -> dict:
    """The persisted settings, read directly (lite_server owns writes; importing
    it here would be circular). Degrades to {} on any failure."""
    path = Path(
        os.getenv("ATELIER_SETTINGS_PATH") or "~/.atelier/settings.json"
    ).expanduser()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _ledger_path() -> Path:
    env = os.getenv("ATELIER_SPEND_PATH")
    if env:
        return Path(env)
    return Path.home() / ".atelier" / "spend.json"


def _today() -> str:
    return datetime.date.today().isoformat()


def _load() -> dict:
    """Today's ledger: {"date": iso, "providers": {host: usd}}. Never raises."""
    try:
        data = json.loads(_ledger_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"date": _today(), "providers": {}}
    if not isinstance(data, dict) or data.get("date") != _today():
        return {"date": _today(), "providers": {}}
    providers = data.get("providers")
    if not isinstance(providers, dict):
        return {"date": _today(), "providers": {}}
    clean = {}
    for host, usd in providers.items():
        if isinstance(host, str) and isinstance(usd, (int, float)) and usd >= 0:
            clean[host] = float(usd)
    return {"date": _today(), "providers": clean}


def _save(data: dict) -> None:
    path = _ledger_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass  # a guardrail must never take the turn down with it


def provider_host(base_url: str) -> str:
    """The ledger key for an agent's base_url: its host (no port, lowercased)."""
    try:
        host = urlparse(str(base_url or "")).hostname or ""
    except ValueError:
        host = ""
    return host.lower() or str(base_url or "")


def is_metered(base_url: str) -> bool:
    """Loopback hosts are the user's own machine — free, never accounted."""
    host = provider_host(base_url)
    if host in ("localhost", ""):
        return False
    try:
        return not ipaddress.ip_address(host).is_loopback
    except ValueError:
        return True  # a non-IP hostname that isn't localhost -> remote


def cap_usd(settings: dict | None = None) -> float:
    """The per-provider daily cap. Absent/garbage -> the $5 default (the cap is
    mandatory-by-default); an explicit numeric 0 (or negative) -> disabled
    (returns 0.0 meaning "no cap"). ``settings`` omitted -> read the file."""
    if settings is None:
        settings = _read_settings()
    if not isinstance(settings, dict):
        return DEFAULT_CAP_USD
    raw = settings.get("spend_cap_usd", DEFAULT_CAP_USD)
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_CAP_USD
    return max(val, 0.0)


def spent_today(host: str) -> float:
    return float(_load()["providers"].get(host, 0.0))


def record(host: str, usd) -> None:
    """Add ``usd`` to today's total for ``host``. Non-positive/garbage = no-op."""
    try:
        amount = float(usd)
    except (TypeError, ValueError):
        return
    if amount <= 0 or not host:
        return
    data = _load()
    data["providers"][host] = data["providers"].get(host, 0.0) + amount
    _save(data)


def allowed(host: str, settings: dict | None = None) -> tuple[bool, float, float]:
    """(ok, spent, cap). cap 0.0 = disabled -> always ok."""
    cap = cap_usd(settings)
    spent = spent_today(host)
    if cap <= 0:
        return True, spent, cap
    return spent < cap, spent, cap


def cap_message(host: str, spent: float, cap: float) -> str:
    return (
        f"Paused: today's spend for {host} reached its ${cap:.2f} cap "
        f"(${spent:.2f} used). Raise or disable the cap in Settings to continue."
    )
