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
    day starts a fresh ledger.
  * A ledger that cannot be READ or WRITTEN is UNKNOWN, not zero. It is never
    silently reset to empty: doing so made one transient bad read the
    persisted truth for the rest of the day, and turned "$0.00 spent" into a
    number nobody measured. ``spent_today`` returns None in that state,
    ``allowed`` fails CLOSED, and /config reports api_spend_today_usd: null so
    the pre-run cost sheet can say the cap cannot be enforced. Nothing here
    raises — a guardrail must not take the turn down with it — but nothing
    here invents a number either.
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


# True once this process has proved today's totals are NOT what the ledger
# says: a write that never landed, or a recorded cost that could not be
# persisted. Latched for the life of the process because the accounting is
# unrecoverable — the amount is gone, so no later successful read makes the
# total trustworthy again. Reset only by _reset_ledger_state() (tests).
_ledger_lost = False


def _reset_ledger_state() -> None:
    """Clear the 'today's totals are unknown' latch (test hook)."""
    global _ledger_lost
    _ledger_lost = False


def _load():
    """Today's ledger, or **None when the ledger cannot be read**.

    Never raises. None means UNKNOWN, and callers must carry that through —
    it is emphatically NOT the same as {"providers": {}}:

      * missing file            -> empty ledger (a genuinely fresh install)
      * date != today           -> empty ledger (a genuinely fresh day)
      * unreadable / corrupt /
        a garbage provider row  -> None (we do not know today's spend)

    The old code collapsed all four into an empty ledger, so one transient
    unreadable read reported $0.00 spent and record() then persisted that
    reset — the cap went inert for the rest of the day.
    """
    path = _ledger_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"date": _today(), "providers": {}}
    except (OSError, ValueError):
        # OSError: permissions, IO error, a directory in the way.
        # ValueError: UnicodeDecodeError on a torn/binary file - read_text
        # decodes, so this escapes before json.loads ever runs.
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None  # corrupt: today's totals are unknown, not zero
    if not isinstance(data, dict):
        return None
    date = data.get("date")
    if not isinstance(date, str):
        return None  # a ledger with no usable date is corrupt, not a new day
    if date != _today():
        return {"date": _today(), "providers": {}}
    providers = data.get("providers")
    if not isinstance(providers, dict):
        return None
    clean = {}
    for host, usd in providers.items():
        # A malformed row means one provider's total is unreadable, which
        # makes the ledger's answer unknown. Dropping the row (the old
        # behavior) silently under-reported spend instead.
        if not (isinstance(host, str) and isinstance(usd, (int, float))
                and not isinstance(usd, bool) and usd >= 0):
            return None
        clean[host] = float(usd)
    return {"date": _today(), "providers": clean}


def _save(data: dict) -> bool:
    """Atomically persist the ledger. Returns False when the write did NOT
    land; latches _ledger_lost so spent_today stops answering with a total
    that is missing this write. Never raises."""
    global _ledger_lost
    path = _ledger_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        # A guardrail must never take the turn down with it — but an
        # unwritable ~/.atelier must not read as "$0.00 spent" either.
        _ledger_lost = True
        return False
    return True


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


def spent_today(host: str) -> float | None:
    """Today's recorded spend for ``host``, or **None when it is unknown**.

    None means the ledger could not be read, or a cost could not be written —
    it does NOT mean $0.00. Callers must surface it as unknown (the /config
    shape sends JSON null) rather than substituting a zero.
    """
    if _ledger_lost:
        return None
    data = _load()
    if data is None:
        return None
    return float(data["providers"].get(host, 0.0))


def record(host: str, usd) -> None:
    """Add ``usd`` to today's total for ``host``. Non-positive/garbage = no-op.

    If the ledger cannot be read, the amount is NOT written over it: rewriting
    a fresh ledger would erase today's accumulated spend and hand the cap a
    fabricated total. The cost is then unaccounted for, so the ledger is
    latched unknown for the rest of the process.
    """
    try:
        amount = float(usd)
    except (TypeError, ValueError):
        return
    # `not (amount > 0)` also rejects NaN, which `amount <= 0` let through.
    if not (amount > 0) or not host:
        return
    data = _load()
    if data is None:
        global _ledger_lost
        _ledger_lost = True  # this cost happened and was never recorded
        return
    data["providers"][host] = data["providers"].get(host, 0.0) + amount
    _save(data)  # a failed write latches _ledger_lost itself


def allowed(host: str, settings: dict | None = None) -> tuple[bool, float | None, float]:
    """(ok, spent, cap). ``spent`` is None when today's total is unknown.

    cap 0.0 = disabled -> always ok (there is no decision to get wrong).
    Otherwise an unknown total fails **CLOSED**: the cap exists to stop a
    runaway loop draining a metered key, and "we cannot tell how much has
    been spent" is not a reason to keep spending.
    """
    cap = cap_usd(settings)
    spent = spent_today(host)
    if cap <= 0:
        return True, spent, cap
    if spent is None:
        return False, None, cap
    return spent < cap, spent, cap


def cap_message(host: str, spent: float | None, cap: float) -> str:
    if spent is None:
        return (
            f"Paused: Atelier cannot read today's spend ledger, so the ${cap:.2f} "
            f"daily cap for {host} cannot be enforced. Fix or delete the ledger "
            f"({_ledger_path()}), or disable the cap in Settings, to continue."
        )
    return (
        f"Paused: today's spend for {host} reached its ${cap:.2f} cap "
        f"(${spent:.2f} used). Raise or disable the cap in Settings to continue."
    )
