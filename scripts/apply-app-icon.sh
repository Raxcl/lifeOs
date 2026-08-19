#!/usr/bin/env bash
# Apply custom app icon for macOS (equivalent to apply-app-icon.ps1).
# Uses built-in macOS tools: sips + iconutil.
#
# Usage:
#   bash scripts/apply-app-icon.sh
#   bash scripts/apply-app-icon.sh --skip-when-unconfigured
#   bash scripts/apply-app-icon.sh --source /path/to/icon.png
#   bash scripts/apply-app-icon.sh --force
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/desktop"
ICONS_DIR="$DESKTOP_DIR/src-tauri/icons"
APP_IDENTIFIER="com.lifeos.morning-journal"

SKIP_WHEN_UNCONFIGURED=false
FORCE=false
SOURCE_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-when-unconfigured) SKIP_WHEN_UNCONFIGURED=true; shift ;;
    --force) FORCE=true; shift ;;
    --source) SOURCE_PATH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ---- 辅助函数 ----

find_settings_file() {
  local app_support="$HOME/Library/Application Support"
  for name in "$APP_IDENTIFIER" "LifeOS Morning Journal" "lifeos-morning-journal"; do
    local candidate="$app_support/$name/settings.json"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
}

get_configured_icon_source() {
  local settings
  settings="$(find_settings_file)"
  if [[ -n "$settings" && -f "$settings" ]]; then
    local src
    src="$(node -e "try{const s=JSON.parse(require('fs').readFileSync('$settings','utf8'));if(s.app_icon_source)console.log(s.app_icon_source)}catch(e){}" 2>/dev/null || true)"
    if [[ -n "$src" && -f "$src" ]]; then
      echo "$src"
      return
    fi
  fi
}

compute_fingerprint() {
  local file="$1"
  shasum -a 256 "$file" | cut -d' ' -f1
}

# ---- 主逻辑 ----

# 解析图标源文件路径
if [[ -z "$SOURCE_PATH" ]]; then
  SOURCE_PATH="$(get_configured_icon_source)"
fi

if [[ -z "$SOURCE_PATH" ]]; then
  if $SKIP_WHEN_UNCONFIGURED; then
    echo "No app icon source configured; skipped icon generation."
    exit 0
  fi
  echo "Error: No app icon source was provided. Choose one in Settings or pass --source." >&2
  exit 1
fi

if [[ ! -f "$SOURCE_PATH" ]]; then
  echo "Error: App icon source does not exist: $SOURCE_PATH" >&2
  exit 1
fi

# 检查指纹缓存
FINGERPRINT_FILE="$ICONS_DIR/.app-icon.fingerprint"
FINGERPRINT="$SOURCE_PATH|$(compute_fingerprint "$SOURCE_PATH")"

if ! $FORCE && [[ -f "$FINGERPRINT_FILE" && -f "$ICONS_DIR/icon.icns" ]]; then
  PREVIOUS="$(cat "$FINGERPRINT_FILE" 2>/dev/null || true)"
  if [[ "$PREVIOUS" == "$FINGERPRINT" ]]; then
    echo "App icon source unchanged; skipped icon generation."
    exit 0
  fi
fi

# 生成归一化 1024x1024 PNG（使用 macOS 内置 sips）
TMP_PNG="$(mktemp /tmp/lifeos-app-icon-XXXXXX.png)"
trap 'rm -f "$TMP_PNG"' EXIT

sips -z 1024 1024 "$SOURCE_PATH" --out "$TMP_PNG" >/dev/null 2>&1

# 调用 Tauri icon 生成
pushd "$DESKTOP_DIR" > /dev/null
npx tauri icon "$TMP_PNG"
TAURI_EXIT=$?
popd > /dev/null

if [[ $TAURI_EXIT -ne 0 ]]; then
  echo "Error: Tauri icon generation failed with exit code $TAURI_EXIT." >&2
  exit $TAURI_EXIT
fi

# 清理 Tauri 生成的 Windows / 移动端无用图标产物
for f in "64x64.png" "StoreLogo.png"; do
  rm -f "$ICONS_DIR/$f"
done
rm -rf "$ICONS_DIR/android" "$ICONS_DIR/ios" 2>/dev/null || true
# 清理 Square*Logo.png
for f in "$ICONS_DIR"/Square*Logo.png; do
  [[ -f "$f" ]] && rm -f "$f"
done

# 保存指纹
echo -n "$FINGERPRINT" > "$FINGERPRINT_FILE"

echo "Updated desktop Tauri icon resources in desktop/src-tauri/icons/."
echo "Restart tauri:dev or run from desktop/: npm run tauri:build:mac"
