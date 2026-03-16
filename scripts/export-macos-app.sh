#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="phasr.sh"
APP_EXECUTABLE="phasr"
BUNDLE_ID="sh.phasr.desktop"
ICON_SVG="internal/api/static/assets/brand/phasr-sh.svg"
DIST_DIR="dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
ICONSET_DIR="$DIST_DIR/.appicon.iconset"
ICON_ICNS="$DIST_DIR/AppIcon.icns"
ZIP_PATH="$DIST_DIR/${APP_NAME}-macOS-arm64.zip"

if [[ ! -f "$ICON_SVG" ]]; then
  echo "Missing icon source: $ICON_SVG" >&2
  exit 1
fi

make desktop-build

UI_VERSION="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' internal/api/static/dist/build-meta.json | head -n1)"
if [[ -z "$UI_VERSION" ]]; then
  UI_VERSION="0.0.0"
fi

rm -rf "$APP_DIR" "$ICONSET_DIR" "$ICON_ICNS" "$ZIP_PATH"
mkdir -p "$DIST_DIR" "$ICONSET_DIR"

# Convert SVG -> PNG and generate required iconset sizes for iconutil.
sips -s format png "$ICON_SVG" --out "$ICONSET_DIR/icon_1024x1024.png" >/dev/null

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICONSET_DIR/icon_1024x1024.png" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
done

for size in 16 32 128 256 512; do
  double_size=$((size * 2))
  sips -z "$double_size" "$double_size" "$ICONSET_DIR/icon_1024x1024.png" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET_DIR" -o "$ICON_ICNS"

CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp bin/phasr-desktop "$MACOS_DIR/$APP_EXECUTABLE"
chmod +x "$MACOS_DIR/$APP_EXECUTABLE"
cp "$ICON_ICNS" "$RESOURCES_DIR/AppIcon.icns"

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_EXECUTABLE}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${UI_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${UI_VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

printf 'APPL????' > "$CONTENTS_DIR/PkgInfo"

ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$ZIP_PATH"

rm -rf "$ICONSET_DIR"

echo "Exported mac app:"
echo "  App: $APP_DIR"
echo "  Zip: $ZIP_PATH"
