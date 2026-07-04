"""Pure regression tests for OpenSwarm wiring config/prompt consistency.

Stdlib + repo files only — no agency_swarm — so this runs under a plain python3:

    python3 tests/test_swarm_wiring.py

Covers:
  * .env.example must declare each variable exactly once. A duplicate blank
    GOOGLE_API_KEY silently overrode the filled provider key (python-dotenv is
    last-occurrence-wins).
  * The coordinator's runtime agent name ("Orchestrator") must match the name
    used in the shared roster/instructions, so `transfer_to_<name>` handoffs
    that specialists are told to use actually resolve. The stale "Agent Swarm"
    label pointed at a nonexistent transfer target.
"""

import os
import re

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_ENV_EXAMPLE = os.path.join(_REPO_ROOT, ".env.example")
_SHARED_INSTRUCTIONS = os.path.join(_REPO_ROOT, "shared_instructions.md")
_ORCHESTRATOR_PY = os.path.join(_REPO_ROOT, "orchestrator", "orchestrator.py")
_ORCHESTRATOR_INSTRUCTIONS = os.path.join(_REPO_ROOT, "orchestrator", "instructions.md")

_ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=")


def _declared_keys(env_path):
    keys = []
    with open(env_path, encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            match = _ASSIGNMENT.match(stripped)
            if match:
                keys.append(match.group(1))
    return keys


def test_env_example_declares_each_key_once():
    keys = _declared_keys(_ENV_EXAMPLE)
    duplicates = {key for key in keys if keys.count(key) > 1}
    assert not duplicates, f".env.example declares duplicate keys: {sorted(duplicates)}"


def test_env_example_google_api_key_declared_once():
    keys = _declared_keys(_ENV_EXAMPLE)
    # Still present (Gemini/Veo need it), but exactly once so a blank second
    # occurrence cannot override a filled provider key.
    assert keys.count("GOOGLE_API_KEY") == 1


def test_orchestrator_code_name_is_orchestrator():
    source = open(_ORCHESTRATOR_PY, encoding="utf-8").read()
    assert 'name="Orchestrator"' in source


def test_shared_instructions_use_orchestrator_not_agent_swarm():
    text = open(_SHARED_INSTRUCTIONS, encoding="utf-8").read()
    assert "Agent Swarm" not in text, "stale coordinator label 'Agent Swarm' in shared_instructions.md"
    assert "Orchestrator" in text


def test_orchestrator_instructions_use_orchestrator_not_agent_swarm():
    text = open(_ORCHESTRATOR_INSTRUCTIONS, encoding="utf-8").read()
    assert "Agent Swarm" not in text, "stale coordinator label 'Agent Swarm' in orchestrator/instructions.md"
    assert "Orchestrator" in text


def _run_all():
    funcs = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    passed = 0
    failed = 0
    for name, func in funcs:
        try:
            func()
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            passed += 1
            print(f"ok   {name}")
    print(f"\n{passed} passed, {failed} failed, {len(funcs)} total")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
