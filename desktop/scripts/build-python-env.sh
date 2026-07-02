#!/bin/bash
# Build the relocatable Python env bundled into Atelier.app (Contents/Resources/python-env).
# Same layout OpenSwarm ships: python-build-standalone install_only + site-packages
# installed straight into the env (no venv). Run from anywhere; writes desktop/build-staging/.
set -euo pipefail

# _stripped variant: same interpreter minus debug symbols (~25M smaller).
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.13.14%2B20260623-aarch64-apple-darwin-install_only_stripped.tar.gz"
DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
STAGE="$DESKTOP_DIR/build-staging"
ENV_DIR="$STAGE/python-env"

rm -rf "$ENV_DIR"
mkdir -p "$STAGE"
echo "==> downloading python-build-standalone"
curl -fsSL "$PBS_URL" | tar -xz -C "$STAGE"
mv "$STAGE/python" "$ENV_DIR"

echo "==> installing backend deps into the env"
# Exactly what lite_server.py's import graph needs; iterate here if boot smoke fails.
uv pip install --python "$ENV_DIR/bin/python3" \
  "agency-swarm==1.10.2" "fastapi==0.138.2" "uvicorn==0.49.0" \
  "composio-openai-agents==0.8.0" \
  "claude-agent-sdk==0.2.110" \
  "apscheduler==3.11.3" "httpx==0.28.1" "pyyaml"

echo "==> diet: drop the never-imported heavy stack (~79M)"
# Verified by execution: importing lite_server + the scheduler daemon + even
# bare agency_swarm loads NONE of these (they back agency-swarm's LiteLLM
# routing, which the lite backend no longer uses since the claude-agent-sdk
# migration). The smoke test below imports the REAL lite_server graph, so a
# future dependency change that re-needs them fails the build loudly.
uv pip uninstall --python "$ENV_DIR/bin/python3" \
  litellm tokenizers hf-xet huggingface_hub 2>/dev/null || true

echo "==> diet: strip interpreter baggage the backend never touches"
rm -rf "$ENV_DIR/include" \
       "$ENV_DIR/lib/tcl8.6" "$ENV_DIR/lib/tk8.6" "$ENV_DIR/lib/tcl8" \
       "$ENV_DIR/lib/python3.13/tkinter" \
       "$ENV_DIR/lib/python3.13/idlelib" \
       "$ENV_DIR/lib/python3.13/ensurepip" \
       "$ENV_DIR/lib/python3.13/pydoc_data" \
       "$ENV_DIR/lib/python3.13/lib-dynload/_tkinter"*.so \
       "$ENV_DIR/lib/libtcl8.6.dylib" "$ENV_DIR/lib/libtk8.6.dylib" 2>/dev/null || true

echo "==> stripping caches + pip"
find "$ENV_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +
"$ENV_DIR/bin/python3" -m pip uninstall -y pip setuptools >/dev/null 2>&1 || true

echo "==> ad-hoc signing Mach-O files (arm64 requires a signature after modification)"
find "$ENV_DIR" \( -name '*.so' -o -name '*.dylib' \) -exec codesign --force -s - {} \; 2>/dev/null
codesign --force -s - "$ENV_DIR/bin/python3.13"

echo "==> smoke test: the REAL backend import graph under the dieted env"
(cd "$REPO_DIR" && "$ENV_DIR/bin/python3" -c "import lite_server; import scheduler.scheduler; print('lite_server + scheduler import ok')")
du -sh "$ENV_DIR"
echo "done"
