#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="phasr.sh"
DIST_DIR="dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
APP_BUNDLE_NAME="$APP_NAME.app"
STAGING_DIR="$DIST_DIR/.dmg-staging"
VOLUME_NAME="phasr.sh Installer"
RW_DMG_PATH="$DIST_DIR/.${APP_NAME}-installer-rw.dmg"
DMG_PATH="$DIST_DIR/${APP_NAME}-installer-arm64.dmg"
BG_DIR_REL=".background"
BG_PNG_NAME="installer-bg.png"
BG_SVG_PATH="$DIST_DIR/.installer-bg.svg"
BG_PNG_PATH="$STAGING_DIR/$BG_DIR_REL/$BG_PNG_NAME"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS installer export is supported only on macOS." >&2
  exit 1
fi

./scripts/export-macos-app.sh

if [[ ! -d "$APP_DIR" ]]; then
  echo "Missing app bundle: $APP_DIR" >&2
  exit 1
fi

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$APP_DIR" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
mkdir -p "$STAGING_DIR/$BG_DIR_REL"

cat > "$BG_SVG_PATH" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="720" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0B0D12"/>
      <stop offset="1" stop-color="#11151C"/>
    </linearGradient>

    <linearGradient id="smile" x1="190" y1="325" x2="530" y2="325" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7C9BFF" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#7C9BFF" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#7C9BFF" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="720" height="420" rx="16" fill="url(#bg)"/>
  <rect x="24" y="24" width="672" height="372" rx="12" stroke="white" stroke-opacity="0.12"/>

  <text x="360" y="96" fill="#F5F7FA" text-anchor="middle" font-size="34" font-family="SF Pro Text, -apple-system, BlinkMacSystemFont, sans-serif" font-weight="700">
    Install phasr.sh
  </text>
  <text x="360" y="132" fill="#B7C0CD" text-anchor="middle" font-size="20" font-family="SF Pro Text, -apple-system, BlinkMacSystemFont, sans-serif" font-weight="500">
    Drag phasr.sh to Applications
  </text>

  <path
    d="M220 285 Q360 365 500 285"
    stroke="url(#smile)"
    stroke-width="14"
    stroke-linecap="round"
    fill="none"
  />
</svg>
SVG

sips -s format png "$BG_SVG_PATH" --out "$BG_PNG_PATH" >/dev/null

rm -f "$DMG_PATH" "$RW_DMG_PATH"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGING_DIR" \
  -fs HFS+ \
  -format UDRW \
  -ov \
  "$RW_DMG_PATH" >/dev/null

ATTACH_OUTPUT="$(hdiutil attach -readwrite -noverify -noautoopen "$RW_DMG_PATH")"
DEVICE="$(echo "$ATTACH_OUTPUT" | awk '/Apple_HFS/ {print $1; exit}')"
MOUNT_POINT="$(echo "$ATTACH_OUTPUT" | awk -F'\t' '/\/Volumes\// {print $NF; exit}')"

if [[ -n "$DEVICE" ]] && [[ -n "$MOUNT_POINT" ]]; then
  osascript <<OSA || true
tell application "Finder"
  set bgAlias to POSIX file "${MOUNT_POINT}/.background/${BG_PNG_NAME}" as alias
  tell disk "$VOLUME_NAME"
    open
    delay 1
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {120, 120, 840, 540}

    set iconOptions to icon view options of container window
    set arrangement of iconOptions to not arranged
    set icon size of iconOptions to 112
    set text size of iconOptions to 14
    set background picture of iconOptions to bgAlias

    set position of item "$APP_BUNDLE_NAME" of container window to {210, 260}
    set position of item "Applications" of container window to {510, 260}

    close
    open
    update without registering applications
    delay 1
  end tell
end tell
OSA

  sync
  hdiutil detach "$DEVICE" >/dev/null
fi

hdiutil convert "$RW_DMG_PATH" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" >/dev/null

rm -rf "$STAGING_DIR" "$RW_DMG_PATH" "$BG_SVG_PATH"

echo "Exported macOS installer:"
echo "  DMG: $DMG_PATH"
