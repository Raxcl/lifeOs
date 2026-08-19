#!/usr/bin/env bash
# Auto-increment the patch version across package.json, tauri.conf.json and Cargo.toml.
# Usage:
#   bash scripts/bump-version.sh
#   bash scripts/bump-version.sh --dry-run
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$SCRIPT_DIR/../desktop"

# 从 package.json 读取当前版本号
CURRENT_VERSION=$(node -e "console.log(require('$DESKTOP_DIR/package.json').version)")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

if $DRY_RUN; then
  echo "[dry-run] $CURRENT_VERSION -> $NEW_VERSION"
else
  echo "Bumping version: $CURRENT_VERSION -> $NEW_VERSION"
fi

update_version() {
  local file="$1"
  local pattern="$2"
  if [[ ! -f "$file" ]]; then
    echo "  [warn] File not found: $file"
    return
  fi
  if $DRY_RUN; then
    echo "  [dry-run] Would update: $file"
  else
    sed -i '' -E "s/${pattern}/\1${NEW_VERSION}/" "$file"
    echo "  Updated: $file"
  fi
}

# package.json & tauri.conf.json: "version": "x.y.z"
update_version "$DESKTOP_DIR/package.json" '("version"[[:space:]]*:[[:space:]]*")[^"]+'
update_version "$DESKTOP_DIR/src-tauri/tauri.conf.json" '("version"[[:space:]]*:[[:space:]]*")[^"]+'

# Cargo.toml: version = "x.y.z" (only the first occurrence under [package])
update_version "$DESKTOP_DIR/src-tauri/Cargo.toml" '(^version[[:space:]]*=[[:space:]]*")[^"]+'

echo "$NEW_VERSION"
