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

# 归一化图标：缩放到 1024x1024，添加 macOS 规范内边距，消除半透明像素。
# - 主要内容区域占 ~83%（四周 ~8.5% padding），与系统图标视觉大小一致
# - 保持 RGBA 格式，Tauri 的 include_image! 宏要求 PNG 带 alpha 通道
# - 所有像素 alpha=255，确保 macOS Dock 正确应用 squircle 蒙版
TMP_PNG="$(mktemp /tmp/lifeos-app-icon-XXXXXX.png)"
trap 'rm -f "$TMP_PNG"' EXIT

python3 -c "
from PIL import Image
src = Image.open('$SOURCE_PATH').convert('RGBA')
target = 1024
content_size = int(target * 0.83)  # ~850px
offset = (target - content_size) // 2
content = src.resize((content_size, content_size), Image.LANCZOS)
canvas = Image.new('RGBA', (target, target), (255,255,255,255))
canvas.paste(content, (offset, offset), content)
canvas.save('$TMP_PNG', 'PNG')
" 2>/dev/null || {
  # Pillow 不可用时回退到 sips
  sips -z 1024 1024 "$SOURCE_PATH" --out "$TMP_PNG" >/dev/null 2>&1
  echo "Warning: Pillow not available; icon generated without padding." >&2
}

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
