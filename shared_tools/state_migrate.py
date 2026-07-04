"""One-time copy-forward of legacy ``~/.openswarm`` state into ``~/.atelier``.

Atelier renamed its on-disk state directory from the fork's ``~/.openswarm`` to
``~/.atelier``. So a user who ran an older build does not lose their agent
memory, scheduler run ledger, or notifications when the default paths move, this
copies any legacy state file that has no ``~/.atelier`` counterpart yet.

Idempotent (skips files already present in the new dir), best-effort (never
raises), and non-destructive (the old dir is left in place). Called once at
lite_server and scheduler startup — whichever runs first migrates; the other
sees the files present and skips. Stdlib-only so every process can import it.
"""

import os
import shutil
from pathlib import Path

LEGACY_STATE_DIR = "~/.openswarm"
NEW_STATE_DIR = "~/.atelier"


def migrate_legacy_state() -> None:
    """Copy legacy ``~/.openswarm`` files into ``~/.atelier`` (only ones missing
    there). Never raises; a single unreadable file does not block the rest."""
    try:
        old = Path(os.path.expanduser(LEGACY_STATE_DIR))
        new = Path(os.path.expanduser(NEW_STATE_DIR))
        if not old.is_dir() or old.resolve() == new.resolve():
            return
        new.mkdir(parents=True, exist_ok=True)
        for item in old.iterdir():
            if not item.is_file():
                continue  # only the flat state files (memory/runs/notifications/.env)
            dest = new / item.name
            if dest.exists():
                continue  # never clobber newer data already in ~/.atelier
            try:
                shutil.copy2(item, dest)
            except Exception:  # noqa: BLE001 - one bad file must not block the others
                pass
    except Exception:  # noqa: BLE001 - migration must never break startup
        pass
