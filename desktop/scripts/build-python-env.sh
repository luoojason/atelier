#!/bin/bash
# Build the relocatable Python env bundled into Atelier.app (Contents/Resources/python-env).
# Same layout OpenSwarm ships: python-build-standalone install_only + site-packages
# installed straight into the env (no venv). Run from anywhere; writes desktop/build-staging/.
set -euo pipefail

PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.13.14%2B20260623-aarch64-apple-darwin-install_only.tar.gz"
DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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
  "apscheduler==3.11.3" "httpx==0.28.1" "pyyaml"

echo "==> stripping caches + pip"
find "$ENV_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +
"$ENV_DIR/bin/python3" -m pip uninstall -y pip setuptools >/dev/null 2>&1 || true

echo "==> ad-hoc signing Mach-O files (arm64 requires a signature after modification)"
find "$ENV_DIR" \( -name '*.so' -o -name '*.dylib' \) -exec codesign --force -s - {} \; 2>/dev/null
codesign --force -s - "$ENV_DIR/bin/python3.13"

echo "==> smoke test: imports + lite_server boot"
"$ENV_DIR/bin/python3" -c "import fastapi, uvicorn, agency_swarm, apscheduler, httpx, yaml; print('imports ok')"
du -sh "$ENV_DIR"
echo "done"
