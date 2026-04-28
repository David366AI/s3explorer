#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)
    PACKAGE_ARCH="x64"
    ;;
  aarch64|arm64)
    PACKAGE_ARCH="arm64"
    ;;
  *)
    PACKAGE_ARCH="$ARCH"
    ;;
esac

PACKAGE_NAME="s3explorer-linux-${PACKAGE_ARCH}.tar.gz"

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

rm -f "dist/${PACKAGE_NAME}"
tar czf "dist/${PACKAGE_NAME}" -C dist s3explorer

echo
echo "Build complete."
echo "Output folder: dist/s3explorer"
echo "Release archive: dist/${PACKAGE_NAME}"
