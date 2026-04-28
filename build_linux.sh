#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if command -v pyinstaller >/dev/null 2>&1; then
  PYINSTALLER_CMD=(pyinstaller)
elif python3 -c "import PyInstaller" >/dev/null 2>&1; then
  PYINSTALLER_CMD=(python3 -m PyInstaller)
else
  echo "PyInstaller is not installed in the system environment."
  echo "Install it first, then re-run this script."
  echo "Examples:"
  echo "  sudo apt install pyinstaller"
  echo "  or install PyInstaller using your preferred system-level method"
  exit 1
fi

echo "Building s3explorer Linux package..."
"${PYINSTALLER_CMD[@]}" \
  --noconfirm \
  --clean \
  --name s3explorer \
  --onedir \
  --add-data "static:static" \
  server.py

echo
echo "Build complete."
echo "Output folder: dist/s3explorer"
