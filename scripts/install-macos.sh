#!/usr/bin/env bash
set -euo pipefail

APP_NAME="phasr.sh.app"
APP_EXECUTABLE="phasr"
CLI_NAME="phasr-desktop"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INSTALL_DIR="${PHASR_INSTALL_DIR:-/Applications}"
BUILD_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --install-dir" >&2
        exit 1
      fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    --build-only)
      BUILD_ONLY=1
      shift
      ;;
    -h|--help)
      cat <<'HELP'
Install phasr.sh desktop app on macOS.

Usage:
  ./scripts/install-macos.sh [--install-dir <path>] [--build-only]

Options:
  --install-dir <path>  Target directory for phasr.sh.app (default: /Applications)
  --build-only          Build/export app bundle only, skip install copy/symlink
HELP
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer supports macOS only." >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd make
require_cmd go
require_cmd npm
require_cmd xcode-select

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required. Run: xcode-select --install" >&2
  exit 1
fi

echo "Building desktop app bundle..."
./scripts/export-macos-app.sh

APP_SOURCE_PATH="$ROOT_DIR/dist/$APP_NAME"
if [[ ! -d "$APP_SOURCE_PATH" ]]; then
  echo "Expected app bundle not found: $APP_SOURCE_PATH" >&2
  exit 1
fi

if [[ "$BUILD_ONLY" == "1" ]]; then
  echo "Build complete:"
  echo "  $APP_SOURCE_PATH"
  exit 0
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR"
fi

if [[ ! -w "$INSTALL_DIR" ]]; then
  FALLBACK_DIR="$HOME/Applications"
  echo "Install directory is not writable: $INSTALL_DIR"
  echo "Falling back to: $FALLBACK_DIR"
  INSTALL_DIR="$FALLBACK_DIR"
  mkdir -p "$INSTALL_DIR"
fi

APP_INSTALL_PATH="$INSTALL_DIR/$APP_NAME"
echo "Installing app to: $APP_INSTALL_PATH"
rm -rf "$APP_INSTALL_PATH"
cp -R "$APP_SOURCE_PATH" "$APP_INSTALL_PATH"

# Remove quarantine attribute if present (best effort).
xattr -dr com.apple.quarantine "$APP_INSTALL_PATH" >/dev/null 2>&1 || true

APP_BINARY_PATH="$APP_INSTALL_PATH/Contents/MacOS/$APP_EXECUTABLE"
LINK_CREATED=0
PATH_BIN_DIR=""

for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  if [[ "$candidate" == "$HOME/.local/bin" || "$candidate" == "$HOME/bin" ]]; then
    mkdir -p "$candidate"
  fi
  if [[ -d "$candidate" && -w "$candidate" ]]; then
    ln -sf "$APP_BINARY_PATH" "$candidate/$CLI_NAME"
    PATH_BIN_DIR="$candidate"
    LINK_CREATED=1
    break
  fi
done

echo "Installed phasr.sh successfully."
echo "  App: $APP_INSTALL_PATH"

if [[ "$LINK_CREATED" == "1" ]]; then
  echo "  CLI: $PATH_BIN_DIR/$CLI_NAME"
  if [[ ":$PATH:" != *":$PATH_BIN_DIR:"* ]]; then
    echo "  Add to PATH: export PATH=\"$PATH_BIN_DIR:\$PATH\""
  fi
else
  echo "  CLI symlink not created (no writable bin dir found)."
  echo "  Run desktop binary directly:"
  echo "    $APP_BINARY_PATH"
fi

echo "Launch app:"
echo "  open \"$APP_INSTALL_PATH\""
