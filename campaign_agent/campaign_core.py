"""Pure functions for a multi-part campaign — no agency_swarm / pydantic.

A campaign is the unit that turns the workforce from single-deliverable into a
coordinated, gated multi-part effort. It captures a goal, the list of
deliverables that goal decomposes into, and — crucially — the *gate* state of
each one: a deliverable is only publishable once the Critic has scored it and
returned a shippable verdict. The meta-agent (Campaign Agent) drives the
pipeline; these functions own the state transitions and the gate so the
"never publish what the Critic did not pass" rule is enforced in code, not left
to the agent's discretion.

Campaign shape (a plain dict, JSON-round-trippable)::

    {
      "id": str,
      "goal": str,
      "project": str | None,
      "brief": dict | None,          # the captured Brief, if any
      "deliverables": [              # one per planned output
          {"type": str, "spec": str, "status": str,
           "path": str | None, "verdict": str | None},
      ],
      "stage": str,                  # planned | producing | gated
      "created_ts": str | None,      # caller-supplied; pure fns never read the clock
    }

Persistence reuses memory_core's single durable, fcntl-locked, atomic append
path (kind="campaign") so campaigns live in the SAME append-only JSON store as
memory entries and briefs — no bespoke unlocked read-modify-write. All the
non-persistence functions are pure and clock-free: plan_campaign / record_result
take a caller-supplied ``ts`` and never call datetime.now themselves.

No dependency on agency_swarm or pydantic: the StartCampaign / RecordDeliverable
/ CampaignStatus BaseTools wrap these functions, and tests import ONLY these pure
helpers + stdlib under the system python3.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

# Reuse the memory store's durable write/read helpers so campaigns share the
# identical on-disk JSON with memory entries and briefs. In production this
# resolves via the shared_tools package; under the system python3 test (which
# has no agency_swarm, so importing the shared_tools package fails) the helpers
# are imported directly from memory_core, which the test puts on sys.path.
try:  # pragma: no cover - exercised by both paths across environments
    from shared_tools.memory_core import _append_entry, _load
except ImportError:  # pragma: no cover
    from memory_core import _append_entry, _load

# Deliverable lifecycle. A deliverable starts "planned", becomes "produced" once
# a specialist returns a result, and "gated" once the Critic's verdict is
# recorded. Only "gated" + verdict=="ship" is publishable.
STATUS_PLANNED = "planned"
STATUS_PRODUCED = "produced"
STATUS_GATED = "gated"

# The verdicts the Critic can return. Anything else (missing, empty, unknown)
# fails safe to "block" so a malformed or absent verdict can never publish.
_KNOWN_VERDICTS = ("ship", "revise", "block")


def _norm(value) -> str | None:
    """Strip a string; collapse empty/None to None."""
    return (str(value).strip() or None) if value is not None else None


def _normalize_spec(item) -> dict:
    """Coerce one deliverable spec into a planned deliverable dict.

    Accepts a dict ({type/dtype, spec/description}) or a bare string (treated as
    the deliverable type with an empty spec). Always returns a well-formed
    deliverable so a sloppy caller can never plant a non-dict into the list.
    """
    if isinstance(item, dict):
        dtype = item.get("type") or item.get("dtype") or ""
        spec = item.get("spec") or item.get("description") or ""
    else:
        dtype = item if isinstance(item, str) else str(item or "")
        spec = ""
    return {
        "type": str(dtype).strip(),
        "spec": str(spec).strip(),
        "status": STATUS_PLANNED,
        "path": None,
        "verdict": None,
    }


def plan_campaign(id, goal, project, deliverable_specs, brief=None, ts=None) -> dict:
    """Build a fresh campaign with every deliverable status="planned".

    ``id`` and ``ts`` are caller-supplied — this function never reads the clock
    or invents an id, so it stays pure and deterministic. ``deliverable_specs``
    is an iterable of specs (dicts or strings); each becomes one planned
    deliverable. ``brief`` is the optional captured Brief to carry alongside the
    campaign so the Critic can score against it later.
    """
    deliverables = [_normalize_spec(item) for item in (deliverable_specs or [])]
    return {
        "id": str(id or "").strip(),
        "goal": (goal or "").strip(),
        "project": _norm(project),
        "brief": dict(brief) if isinstance(brief, dict) else None,
        "deliverables": deliverables,
        "stage": STATUS_PLANNED,
        "created_ts": ts,
    }


def _deliverables(campaign) -> list:
    """Return the campaign's deliverable list, tolerating a malformed campaign."""
    if not isinstance(campaign, dict):
        return []
    items = campaign.get("deliverables")
    return items if isinstance(items, list) else []


def _stage_for(deliverables) -> str:
    """Derive the overall campaign stage from its deliverables' statuses.

    - no deliverables or all still planned -> "planned"
    - every deliverable has a verdict recorded (gated) -> "gated"
    - otherwise at least one is in flight -> "producing"
    """
    dicts = [d for d in deliverables if isinstance(d, dict)]
    if not dicts:
        return STATUS_PLANNED
    statuses = [d.get("status") for d in dicts]
    if all(s == STATUS_GATED for s in statuses):
        return STATUS_GATED
    if all(s == STATUS_PLANNED for s in statuses):
        return STATUS_PLANNED
    return "producing"


def record_result(campaign, dtype, path=None, verdict=None) -> dict:
    """Return a NEW campaign with the deliverable of type ``dtype`` advanced.

    The input campaign is not mutated (a fresh copy is returned). The first
    deliverable whose ``type`` matches ``dtype`` is advanced:

      - a ``verdict`` (if given) is recorded and the status becomes "gated",
        recording any ``path`` supplied in the same call;
      - a NEW ``path`` with no fresh verdict invalidates any prior verdict —
        the Critic passed the OLD artifact, not this one — so the verdict is
        cleared and the status drops back to "produced" for re-gating;
      - with no verdict and no new path, a still-"planned" deliverable becomes
        "produced" (an already-gated deliverable keeps its verdict untouched).

    So the lifecycle is planned -> produced (result in) -> gated (verdict in),
    and swapping in a fresh artifact re-opens the gate. A ``dtype`` that matches
    nothing leaves the campaign unchanged (no raise).
    """
    want = str(dtype or "").strip()
    new_deliverables = []
    advanced = False
    for d in _deliverables(campaign):
        d = dict(d) if isinstance(d, dict) else _normalize_spec(d)
        if not advanced and str(d.get("type") or "").strip() == want:
            advanced = True
            path_changed = path is not None and path != d.get("path")
            if verdict is not None:
                # A fresh Critic verdict (re)gates the deliverable, binding to
                # the path supplied in this same call (if any).
                if path is not None:
                    d["path"] = path
                d["verdict"] = verdict
                d["status"] = STATUS_GATED
            elif path_changed:
                # A NEW artifact path arrived with no fresh verdict. Any prior
                # verdict was the Critic's judgment of the OLD path and is now
                # stale, so clear it and drop back to "produced": the new
                # artifact MUST be re-gated before it can publish. Without this,
                # ready_to_publish would surface an un-reviewed path under a
                # carried-over "ship" verdict (the path-swap-after-ship gap).
                d["path"] = path
                d["verdict"] = None
                d["status"] = STATUS_PRODUCED
            elif d.get("status") in (None, STATUS_PLANNED):
                # No verdict, no new path (path absent or identical): advance a
                # still-planned deliverable to produced; an already-gated one is
                # left exactly as it is (never silently downgraded).
                d["status"] = STATUS_PRODUCED
        new_deliverables.append(d)

    base = dict(campaign) if isinstance(campaign, dict) else {}
    base["deliverables"] = new_deliverables
    base["stage"] = _stage_for(new_deliverables)
    return base


def gate(deliverable) -> str:
    """Return the publish gate for one deliverable: "ship" | "revise" | "block".

    This is where the Critic's verdict becomes an enforced gate rather than a
    suggestion: a deliverable can only ever be published when its recorded
    verdict is "ship". The gate fails safe to "block" for anything else —

      - a missing or None verdict (never reviewed),
      - an explicit "block" verdict,
      - an unrecognized/garbage verdict, or a non-dict deliverable —

    so nothing the Critic did not affirmatively pass can slip through. A "revise"
    verdict returns "revise" (not publishable, but distinguished from a block).

    TRUST BOUNDARY (by design, not a defect fixable here): this gate proves the
    *value* "ship" is present; it cannot prove that value *originated from the
    Critic*. ``verdict`` is a free field written by whatever called
    record_result (the RecordDeliverable tool passes an agent-supplied string),
    so an agent that writes verdict="ship" without ever consulting the Critic
    passes the gate. Verdict *provenance* is enforced procedurally by the meta-
    agent's instructions ("You do not decide the verdict — the Critic does"),
    not in code. record_result does defend the linked invariant that the shipped
    verdict must match the shipped artifact: swapping in a new path clears a
    stale verdict (see record_result), so the gate always reflects the Critic's
    verdict of the *current* path even though it cannot attest who authored it.
    """
    if not isinstance(deliverable, dict):
        return "block"
    verdict = deliverable.get("verdict")
    if verdict not in _KNOWN_VERDICTS or verdict == "block":
        return "block"
    return verdict


def ready_to_publish(campaign) -> list:
    """Return the deliverables whose gate() == "ship" (safe to publish).

    This is the ONLY list the Campaign Agent hands to the Publisher: everything
    the Critic did not pass is excluded here, in code.
    """
    return [d for d in _deliverables(campaign) if gate(d) == "ship"]


def campaign_status(campaign) -> dict:
    """Return a compact summary of a campaign: counts by status and by gate.

    Defensive: a malformed or partial campaign never raises here — unknown
    statuses are still counted under their raw label, and non-dict deliverables
    are ignored.
    """
    deliverables = _deliverables(campaign)
    by_status: dict = {}
    by_gate = {"ship": 0, "revise": 0, "block": 0}
    for d in deliverables:
        if not isinstance(d, dict):
            continue
        status = str(d.get("status") or STATUS_PLANNED)
        by_status[status] = by_status.get(status, 0) + 1
        by_gate[gate(d)] = by_gate.get(gate(d), 0) + 1
    cid = campaign.get("id") if isinstance(campaign, dict) else None
    goal = campaign.get("goal") if isinstance(campaign, dict) else None
    stage = campaign.get("stage") if isinstance(campaign, dict) else None
    project = campaign.get("project") if isinstance(campaign, dict) else None
    return {
        "id": cid,
        "goal": goal,
        "project": project,
        "stage": stage,
        "total": sum(1 for d in deliverables if isinstance(d, dict)),
        "by_status": by_status,
        "by_gate": by_gate,
        "ready_to_publish": len(ready_to_publish(campaign)),
    }


def save_campaign(campaign, memory_path) -> dict:
    """Append ``campaign`` to the memory JSON at ``memory_path`` and return the entry.

    Uses memory_core._append_entry — the SAME durable write path memory entries
    and briefs share: the load->append->write runs under an exclusive
    cross-process lock, the file is replaced atomically, and a pre-existing
    corrupt store is preserved to a sibling backup rather than clobbered. The
    entry is shaped like a memory entry ({ts, kind, text, project}) plus an
    ``id`` and a ``campaign`` key holding the full campaign dict; kind is
    "campaign". ``ts`` is stamped here (persistence may read the clock; the pure
    planning functions do not).
    """
    path = Path(memory_path).expanduser()
    is_dict = isinstance(campaign, dict)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "kind": "campaign",
        "text": (campaign.get("goal") if is_dict else "") or "",
        "project": _norm(campaign.get("project") if is_dict else None),
        "id": (campaign.get("id") if is_dict else None),
        "campaign": dict(campaign) if is_dict else {},
    }
    return _append_entry(path, entry)


def load_campaign(id_or_project, memory_path):
    """Return the latest stored campaign matching ``id_or_project``, or None.

    The store is append-only, so the last matching entry is the latest campaign.
    A campaign matches when the query equals either its ``id`` or its ``project``
    (normalized: whitespace-trimmed, empty == None). Reading is fully defensive —
    a non-dict entry, a missing ``campaign`` key, or a malformed stored campaign
    is skipped rather than raising.
    """
    path = Path(memory_path).expanduser()
    want = _norm(id_or_project)
    latest = None
    for entry in _load(path):
        if not isinstance(entry, dict) or entry.get("kind") != "campaign":
            continue
        campaign = entry.get("campaign")
        if not isinstance(campaign, dict):
            continue
        cid = _norm(campaign.get("id"))
        proj = _norm(campaign.get("project"))
        if want == cid or want == proj:
            latest = campaign
    return latest
