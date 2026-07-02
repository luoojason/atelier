"""Pure job-definition logic for the OpenSwarm scheduler.

This module deliberately has **no** dependency on APScheduler, httpx,
agency_swarm, or pydantic. Everything here is plain functions over stdlib
types so it can be imported and unit-tested with a bare ``python3``.

A "job" is a small mapping:

    {
        "name":     "morning-standup",     # required, unique-ish label
        "schedule": "0 9 * * *"  |  "30m",  # required, cron string OR interval
        "prompt":   "Summarize ...",        # text sent to the agency
        "builtin":  "digest",               # OR a local builtin (no agency POST)
        "agent":    "orchestrator",         # optional recipient agent name
        "endpoint": "http://host:8080",     # optional per-job base-URL override
        "catch_up": "1d",                   # optional whole-day catch-up window
    }

``schedule`` is either an *interval* shorthand (``30s`` / ``30m`` / ``2h`` /
``1d``) or a 5- or 6-field *cron* string. A job must carry exactly one of
``prompt`` (fired at the agency HTTP endpoint) or ``builtin`` (run locally by
the daemon; the only builtin is ``"digest"``). ``catch_up`` marks the job for a
one-shot fire shortly after daemon start when the runs ledger has no "ok"
record for it inside the window (see :func:`plan_catch_ups`).
"""

from __future__ import annotations

import datetime
import re

# --------------------------------------------------------------------------- #
# Interval parsing
# --------------------------------------------------------------------------- #

_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
_INTERVAL_RE = re.compile(r"^\s*(\d+)([smhd])\s*$", re.IGNORECASE)

REQUIRED_FIELDS = ("name", "schedule")
PAYLOAD_FIELDS = ("prompt", "builtin")  # exactly one of these is required
OPTIONAL_FIELDS = ("agent", "endpoint", "catch_up")
ALLOWED_FIELDS = REQUIRED_FIELDS + PAYLOAD_FIELDS + OPTIONAL_FIELDS

# The builtins the daemon can run locally (no agency POST). Kept as a tuple so
# validate_job can reject a typo'd builtin with a clean per-job ValueError.
BUILTIN_JOBS = ("digest",)

# catch_up accepts whole days only ("1d", "7d") — deliberately stricter than
# the interval shorthand so a junk window is caught at validation time.
_CATCH_UP_RE = re.compile(r"^\s*(\d+)d\s*$", re.IGNORECASE)

# Catch-up stagger: the first stale job fires CATCH_UP_INITIAL_DELAY seconds
# after daemon start, each subsequent one CATCH_UP_STAGGER seconds later, so
# several catch-ups never stampede parallel claude sessions at boot.
CATCH_UP_INITIAL_DELAY = 20
CATCH_UP_STAGGER = 45

# --------------------------------------------------------------------------- #
# Cron field validation
#
# These mirror APScheduler's CronTrigger so that anything build_trigger accepts
# will construct a CronTrigger without raising, and anything CronTrigger would
# reject is rejected here first (as a clean per-job ValueError) instead of
# aborting the whole daemon at startup. Kept pure (no apscheduler import) so the
# rules are unit-testable with a bare python3.
# --------------------------------------------------------------------------- #

# (min, max) inclusive, matching apscheduler.triggers.cron.fields MIN/MAX_VALUES.
_CRON_FIELD_RANGES = {
    "second": (0, 59),
    "minute": (0, 59),
    "hour": (0, 23),
    "day": (1, 31),
    "month": (1, 12),
    "day_of_week": (0, 6),
}

# APScheduler weekday order: mon=0 ... sun=6 (the first weekday is Monday).
_APS_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_MONTH_NAMES = (
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
)

_STAR_RE = re.compile(r"^\*(?:/(\d+))?$")
_NUM_RE = re.compile(r"^(\d+)(?:-(\d+))?(?:/(\d+))?$")
_NAME_RE = re.compile(r"^[A-Za-z]+(?:-[A-Za-z]+)?$")


def is_interval(schedule: str) -> bool:
    """Return True when *schedule* looks like an interval shorthand ("30m")."""
    return bool(_INTERVAL_RE.match(schedule or ""))


def parse_interval(text: str) -> int:
    """Convert an interval shorthand into a number of seconds.

    Accepts ``s`` (seconds), ``m`` (minutes), ``h`` (hours), ``d`` (days).

    >>> parse_interval("30m")
    1800
    >>> parse_interval("2h")
    7200
    >>> parse_interval("1d")
    86400
    """
    if not isinstance(text, str):
        raise ValueError(f"interval must be a string, got {type(text).__name__}")
    match = _INTERVAL_RE.match(text)
    if not match:
        raise ValueError(
            f"invalid interval {text!r}; use forms like '30s', '30m', '2h', '1d'"
        )
    value = int(match.group(1))
    if value <= 0:
        raise ValueError(f"interval must be positive, got {text!r}")
    return value * _UNIT_SECONDS[match.group(2).lower()]


def parse_catch_up(text) -> int:
    """Convert a catch_up window ("1d", "7d") into a number of seconds.

    Strict on purpose: only positive whole days are accepted, so a junk value
    is rejected at validation time with a clean ValueError (the same
    per-job-never-crashes-the-daemon behavior the cron validation has).

    >>> parse_catch_up("1d")
    86400
    >>> parse_catch_up("7d")
    604800
    """
    if not isinstance(text, str):
        raise ValueError(f"catch_up must be a string, got {type(text).__name__}")
    match = _CATCH_UP_RE.match(text)
    if not match:
        raise ValueError(
            f"invalid catch_up {text!r}; use whole days like '1d' or '7d'"
        )
    value = int(match.group(1))
    if value <= 0:
        raise ValueError(f"catch_up must be positive, got {text!r}")
    return value * 86400


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #


def validate_job(job) -> dict:
    """Validate one job mapping and return a normalized copy.

    Raises ``ValueError`` (or ``TypeError``) on any malformed shape. On success
    returns a new dict with whitespace-stripped string fields and only the
    recognized keys retained.
    """
    if not isinstance(job, dict):
        raise TypeError(f"job must be a mapping, got {type(job).__name__}")

    normalized: dict = {}

    for field in REQUIRED_FIELDS:
        if field not in job or job[field] is None:
            raise ValueError(f"job is missing required field {field!r}: {job!r}")
        value = job[field]
        if not isinstance(value, str):
            raise ValueError(f"job field {field!r} must be a string, got {value!r}")
        value = value.strip()
        if not value:
            raise ValueError(f"job field {field!r} must not be empty: {job!r}")
        normalized[field] = value

    # The payload fields are individually optional but exactly one must be
    # present (checked below); a present-but-empty one is an error, not an
    # omission, so a blank "prompt:" line still reports "must not be empty".
    for field in PAYLOAD_FIELDS:
        value = job.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            raise ValueError(f"job field {field!r} must be a string, got {value!r}")
        value = value.strip()
        if not value:
            raise ValueError(f"job field {field!r} must not be empty: {job!r}")
        normalized[field] = value

    for field in OPTIONAL_FIELDS:
        value = job.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            raise ValueError(f"job field {field!r} must be a string, got {value!r}")
        value = value.strip()
        if value:
            normalized[field] = value

    unknown = set(job) - set(ALLOWED_FIELDS)
    if unknown:
        raise ValueError(
            f"job {normalized.get('name', '?')!r} has unknown field(s): "
            f"{sorted(unknown)}"
        )

    # Exactly one of prompt|builtin: a job either POSTs a prompt at the agency
    # or runs a local builtin, never both and never neither.
    if ("prompt" in normalized) == ("builtin" in normalized):
        raise ValueError(
            f"job {normalized['name']!r} must have exactly one of "
            f"'prompt' or 'builtin': {job!r}"
        )
    builtin = normalized.get("builtin")
    if builtin is not None and builtin not in BUILTIN_JOBS:
        raise ValueError(
            f"job {normalized['name']!r} has unknown builtin {builtin!r}; "
            f"allowed: {sorted(BUILTIN_JOBS)}"
        )

    # A junk catch_up window is a validation error, exactly like a junk cron.
    if "catch_up" in normalized:
        parse_catch_up(normalized["catch_up"])

    # Schedule must be a well-formed interval or cron string; build_trigger
    # raises with a precise message when it is neither.
    build_trigger(normalized)

    return normalized


def _check_step(field: str, step: int, part: str) -> None:
    """Validate a ``*/step`` increment for *field* (matches AllExpression)."""
    lo, hi = _CRON_FIELD_RANGES[field]
    if step <= 0:
        raise ValueError(
            f"invalid cron field {field!r}: increment must be > 0 in {part!r}"
        )
    if step > hi - lo:
        raise ValueError(
            f"invalid cron field {field!r}: step {step} exceeds the field range "
            f"({hi - lo}) in {part!r}"
        )


def _check_numeric(field: str, first: int, last, step, part: str) -> None:
    """Validate a numeric ``N`` / ``N-M`` / ``N-M/step`` component.

    Replicates apscheduler RangeExpression.validate_range so that a value this
    accepts will not blow up inside CronTrigger.
    """
    lo, hi = _CRON_FIELD_RANGES[field]
    if step is not None and step <= 0:
        raise ValueError(
            f"invalid cron field {field!r}: increment must be > 0 in {part!r}"
        )
    # A bare "N" (no range, no step) behaves as the range N-N.
    eff_last = last if last is not None else (first if step is None else None)
    if first < lo:
        raise ValueError(
            f"invalid cron field {field!r}: value {first} is below the minimum "
            f"({lo}) in {part!r}"
        )
    if eff_last is not None and eff_last > hi:
        raise ValueError(
            f"invalid cron field {field!r}: value {eff_last} is above the maximum "
            f"({hi}) in {part!r}"
        )
    if last is not None and first > last:
        raise ValueError(
            f"invalid cron field {field!r}: range start after end in {part!r}"
        )
    value_range = (eff_last if eff_last is not None else hi) - first
    if step is not None and step > value_range:
        raise ValueError(
            f"invalid cron field {field!r}: step {step} exceeds the range "
            f"({value_range}) in {part!r}"
        )


def _validate_name_range(field: str, part: str, names: tuple) -> None:
    """Validate a name / name-range component (month or weekday names)."""
    first, _, last = part.lower().partition("-")
    if first not in names:
        raise ValueError(
            f"invalid cron field {field!r}: unknown name {first!r} in {part!r}"
        )
    if last:
        if last not in names:
            raise ValueError(
                f"invalid cron field {field!r}: unknown name {last!r} in {part!r}"
            )
        if names.index(first) > names.index(last):
            raise ValueError(
                f"invalid cron field {field!r}: range start after end in {part!r}"
            )


def _validate_cron_field(field: str, expr: str) -> None:
    """Validate one whole cron field (a comma-separated list of components).

    Raises ``ValueError`` on anything CronTrigger would reject. ``day_of_week``
    is handled separately by :func:`_normalize_weekday` (it also remaps the
    Unix-cron numbering), so this covers second/minute/hour/day/month.
    """
    allow_names = field == "month"
    for raw in expr.split(","):
        part = raw.strip()
        if not part:
            raise ValueError(
                f"invalid cron field {field!r}: empty component in {expr!r}"
            )
        # Day-of-month supports the literal "last" (last day of the month).
        if field == "day" and part.lower() == "last":
            continue
        star = _STAR_RE.match(part)
        if star:
            if star.group(1) is not None:
                _check_step(field, int(star.group(1)), part)
            continue
        if allow_names and _NAME_RE.match(part):
            _validate_name_range(field, part, _MONTH_NAMES)
            continue
        num = _NUM_RE.match(part)
        if not num:
            raise ValueError(
                f"invalid cron field {field!r}: unrecognized component {part!r} "
                f"in {expr!r}"
            )
        first = int(num.group(1))
        last = int(num.group(2)) if num.group(2) is not None else None
        step = int(num.group(3)) if num.group(3) is not None else None
        _check_numeric(field, first, last, step, part)


def _add_weekday_component(part: str, out: set) -> None:
    """Collect the APScheduler weekday indices covered by one component.

    Accepts standard Unix-cron numbering (0 or 7 = Sunday, 1 = Monday) as well
    as APScheduler weekday names (mon..sun), and translates the numbers into
    APScheduler's mon=0..sun=6 space.
    """
    star = _STAR_RE.match(part)
    if star:
        step = int(star.group(1)) if star.group(1) is not None else 1
        if step <= 0 or step > 6:
            raise ValueError(
                f"invalid cron field 'day_of_week': bad increment in {part!r}"
            )
        for unix in range(0, 7, step):
            out.add((unix - 1) % 7)  # Unix 0=Sun -> APScheduler 6=sun
        return

    name = _NAME_RE.match(part)
    if name:
        first, _, last = part.lower().partition("-")
        if first not in _APS_WEEKDAYS:
            raise ValueError(
                f"invalid cron field 'day_of_week': unknown name {first!r}"
            )
        start = _APS_WEEKDAYS.index(first)
        if not last:
            out.add(start)
            return
        if last not in _APS_WEEKDAYS:
            raise ValueError(
                f"invalid cron field 'day_of_week': unknown name {last!r}"
            )
        end = _APS_WEEKDAYS.index(last)
        if start > end:
            raise ValueError(
                f"invalid cron field 'day_of_week': range start after end in {part!r}"
            )
        out.update(range(start, end + 1))
        return

    num = _NUM_RE.match(part)
    if not num:
        raise ValueError(
            f"invalid cron field 'day_of_week': unrecognized component {part!r}"
        )
    first = int(num.group(1))
    last = int(num.group(2)) if num.group(2) is not None else None
    step = int(num.group(3)) if num.group(3) is not None else None
    if step is not None and step <= 0:
        raise ValueError(
            f"invalid cron field 'day_of_week': increment must be > 0 in {part!r}"
        )
    for value in (first, last):
        if value is not None and not 0 <= value <= 7:
            raise ValueError(
                f"invalid cron field 'day_of_week': value {value} out of range 0-7 "
                f"in {part!r}"
            )
    if last is not None and first > last:
        raise ValueError(
            f"invalid cron field 'day_of_week': range start after end in {part!r}"
        )
    if last is not None:
        end = last
    elif step is not None:
        end = 7
    else:
        end = first
    for unix in range(first, end + 1, step or 1):
        out.add((unix - 1) % 7)  # Unix 0/7=Sun -> APScheduler 6=sun


def _normalize_weekday(expr: str) -> str:
    """Validate a day-of-week field and remap it to APScheduler's convention.

    The advertised format is standard Unix cron, where the weekday field uses
    ``0`` or ``7`` for Sunday and ``1`` for Monday. APScheduler's CronTrigger,
    however, numbers weekdays ``mon=0 .. sun=6``. Passing the raw number through
    silently mis-schedules (e.g. ``0`` would fire Monday) and ``7`` would crash.
    We therefore normalize to explicit APScheduler weekday names.
    """
    expr = expr.strip()
    if expr == "*":
        return "*"
    indices: set = set()
    for raw in expr.split(","):
        part = raw.strip()
        if not part:
            raise ValueError(
                f"invalid cron field 'day_of_week': empty component in {expr!r}"
            )
        _add_weekday_component(part, indices)
    if not indices:
        raise ValueError(f"invalid cron field 'day_of_week': {expr!r}")
    return ",".join(_APS_WEEKDAYS[i] for i in sorted(indices))


def build_trigger(job: dict) -> dict:
    """Return a plain description of the trigger the scheduler should build.

    For an interval schedule:
        {"type": "interval", "seconds": <int>}
    For a cron schedule:
        {"type": "cron", "cron": "<raw>", "fields": {minute: .., hour: .., ...}}

    Every cron field is validated (range + syntax) and the day-of-week field is
    remapped from Unix-cron numbering to APScheduler's, so a returned ``fields``
    dict always constructs a CronTrigger cleanly. Raises ``ValueError`` when the
    schedule is neither a valid interval nor a valid 5/6-field cron string.
    """
    schedule = job["schedule"]

    if is_interval(schedule):
        return {"type": "interval", "seconds": parse_interval(schedule)}

    fields = schedule.split()
    if len(fields) == 5:
        keys = ["minute", "hour", "day", "month", "day_of_week"]
    elif len(fields) == 6:
        keys = ["second", "minute", "hour", "day", "month", "day_of_week"]
    else:
        raise ValueError(
            f"invalid schedule {schedule!r}; expected an interval like '30m' or a "
            f"cron string with 5 or 6 space-separated fields"
        )

    mapping = dict(zip(keys, fields))
    for key in keys:
        if key == "day_of_week":
            mapping[key] = _normalize_weekday(mapping[key])
        else:
            _validate_cron_field(key, mapping[key])
    return {"type": "cron", "cron": schedule, "fields": mapping}


# --------------------------------------------------------------------------- #
# Catch-up planning (pure; the daemon turns plans into one-shot fires)
# --------------------------------------------------------------------------- #


def has_recent_ok(records, name: str, cutoff_ts: str) -> bool:
    """True when *records* holds an ok run of *name* at or after *cutoff_ts*.

    ``records`` is a run_store ledger list (dicts with ``name`` / ``status`` /
    ``ts``); non-dict entries are ignored. ISO timestamps compare
    lexicographically, so a plain string comparison suffices.
    """
    for record in records or []:
        if not isinstance(record, dict):
            continue
        if record.get("name") != name or record.get("status") != "ok":
            continue
        if str(record.get("ts") or "") >= cutoff_ts:
            return True
    return False


def plan_catch_ups(jobs, records, now=None) -> list:
    """Return staggered catch-up plans for jobs whose window has no ok run.

    For each job carrying ``catch_up``, checks *records* (the runs ledger) for
    a record with the job's name and ``status == "ok"`` newer than
    ``now - window``; when none exists the job is planned for a one-shot fire.
    Plans are staggered — the first at :data:`CATCH_UP_INITIAL_DELAY` seconds,
    each subsequent one :data:`CATCH_UP_STAGGER` seconds later — so several
    stale jobs never spawn parallel claude sessions at once.

    Returns ``[{"job": <job dict>, "delay": <seconds>}, ...]`` in jobs order.
    ``now`` (a datetime) is injectable for tests; defaults to the local clock.
    """
    if now is None:
        now = datetime.datetime.now()
    plans: list = []
    for job in jobs:
        window = job.get("catch_up")
        if not window:
            continue
        cutoff = (
            now - datetime.timedelta(seconds=parse_catch_up(window))
        ).isoformat(timespec="seconds")
        if has_recent_ok(records, job["name"], cutoff):
            continue
        delay = CATCH_UP_INITIAL_DELAY + CATCH_UP_STAGGER * len(plans)
        plans.append({"job": job, "delay": delay})
    return plans


# --------------------------------------------------------------------------- #
# YAML loading (pyyaml when available, tiny fallback parser otherwise)
# --------------------------------------------------------------------------- #


def _extract_job_list(data) -> list:
    """Coerce parsed YAML into a list of raw job mappings.

    Accepts either a top-level list, or a mapping with a top-level ``jobs:``
    key holding a list.
    """
    if isinstance(data, dict) and "jobs" in data:
        data = data["jobs"]
    if data is None:
        return []
    if not isinstance(data, list):
        raise ValueError(
            "jobs file must be a YAML list of jobs (or a mapping with a 'jobs:' list)"
        )
    return data


def load_jobs(path: str) -> list:
    """Read *path*, parse the YAML, and return a list of validated job dicts.

    Uses PyYAML when it is installed; otherwise falls back to a tiny built-in
    parser that understands the flat "list of mappings" shape used by
    ``jobs.example.yaml``.
    """
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()

    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
    except ImportError:
        data = _tiny_yaml_load(text)

    raw_jobs = _extract_job_list(data)
    jobs = [validate_job(item) for item in raw_jobs]

    names = [j["name"] for j in jobs]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise ValueError(f"duplicate job name(s): {sorted(dupes)}")

    return jobs


def load_jobs_lenient(path: str) -> tuple:
    """Like ``load_jobs`` but per-job problems are collected, not raised.

    Returns ``(jobs, errors)``: the valid job dicts in file order, plus a
    human-readable string for every entry that failed validation or reused an
    earlier name (first occurrence wins). The daemon uses this so one typo in
    the user-editable jobs file skips that job instead of killing every other
    job at boot. File-level problems (unreadable file, unparseable YAML, wrong
    top-level shape) still raise — nothing there is salvageable to schedule.
    """
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()

    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
    except ImportError:
        data = _tiny_yaml_load(text)

    raw_jobs = _extract_job_list(data)

    jobs: list = []
    errors: list = []
    seen: set = set()
    for index, item in enumerate(raw_jobs):
        try:
            job = validate_job(item)
        except ValueError as exc:
            name = item.get("name") if isinstance(item, dict) else None
            label = repr(name) if isinstance(name, str) and name else f"#{index + 1}"
            errors.append(f"job {label}: {exc}")
            continue
        if job["name"] in seen:
            errors.append(f"job {job['name']!r}: duplicate name (first occurrence wins)")
            continue
        seen.add(job["name"])
        jobs.append(job)
    return jobs, errors


def _strip_inline_comment(value: str) -> str:
    """Remove a trailing ``# comment`` from a value that is not quoted."""
    result = []
    for index, char in enumerate(value):
        if char == "#" and (index == 0 or value[index - 1] in " \t"):
            break
        result.append(char)
    return "".join(result).strip()


def _parse_scalar(value: str) -> str:
    """Parse a YAML scalar: a quoted string (ignoring any trailing comment) or
    a bare value with an optional inline ``# comment`` stripped."""
    value = value.strip()
    if value and value[0] in "\"'":
        quote = value[0]
        end = value.find(quote, 1)
        if end == -1:
            raise ValueError(f"unterminated quoted value: {value!r}")
        return value[1:end]
    return _strip_inline_comment(value)


def _tiny_yaml_load(text: str) -> list:
    """Minimal parser for a flat YAML list of single-level mappings.

    Supports exactly what ``jobs.example.yaml`` needs: ``- key: value`` items,
    continuation ``key: value`` lines, ``#`` comments (full-line and inline for
    unquoted values), quoted values, and blank lines. It is intentionally not a
    general YAML implementation; it only exists so ``load_jobs`` still works when
    PyYAML is not installed.
    """
    jobs: list = []
    current: dict | None = None
    seen_list_item = False

    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue

        stripped = line.lstrip()

        # Optional top-level "jobs:" wrapper mapping (the same shape PyYAML and
        # _extract_job_list accept). It must appear before any list item and
        # carry an empty value; the "- " job items follow it. Without this the
        # fallback parsed such a file differently from PyYAML (it crashed).
        if not seen_list_item and current is None and not stripped.startswith("- "):
            key_part, sep, val_part = stripped.partition(":")
            if sep and key_part.strip() == "jobs" and _strip_inline_comment(val_part) == "":
                continue

        if stripped.startswith("- "):
            seen_list_item = True
            current = {}
            jobs.append(current)
            stripped = stripped[2:].strip()
            if not stripped:
                continue

        if current is None:
            raise ValueError(
                f"line {lineno}: mapping entry before any '- ' list item: {raw!r}"
            )

        if ":" not in stripped:
            raise ValueError(f"line {lineno}: expected 'key: value', got {raw!r}")

        key, _, value = stripped.partition(":")
        current[key.strip()] = _parse_scalar(value)

    return jobs


# --------------------------------------------------------------------------- #
# Run-log formatting (pure; used by the daemon)
# --------------------------------------------------------------------------- #


def format_run_line(name: str, status: str, detail: str = "", when=None) -> str:
    """Format one append-only run-log line.

    >>> line = format_run_line("job1", "ok", "200", when="2026-07-01T09:00:00")
    >>> line
    '2026-07-01T09:00:00\\tjob1\\tok\\t200'
    """
    if when is None:
        when = datetime.datetime.now().isoformat(timespec="seconds")
    detail = " ".join(str(detail).split())  # collapse newlines/whitespace
    return f"{when}\t{name}\t{status}\t{detail}".rstrip()
