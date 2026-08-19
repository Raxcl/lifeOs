#!/usr/bin/env bash
# 一键构建 LifeOS 桌面应用（macOS 版）。
# 生成 .app 和 .dmg 安装包到 dist/ 文件夹。
#
# Usage:
#   ./build.sh             # 完整构建（自动安装依赖）
#   ./build.sh --skip-check # 跳过环境检查
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$REPO_ROOT/desktop"
DIST_DIR="$REPO_ROOT/dist"

echo ""
echo "=== LifeOS 一键构建 (macOS) ==="
echo ""

# ============================================================
# 1. 环境检查
# ============================================================

SKIP_CHECK=false
[[ "${1:-}" == "--skip-check" ]] && SKIP_CHECK=true

if ! $SKIP_CHECK; then
  echo "[1/4] 检查构建环境..."

  if ! command -v node &>/dev/null; then
    echo "Error: 未找到 Node.js，请先安装: https://nodejs.org/" >&2
    exit 1
  fi
  echo "  Node.js  $(node --version)"

  if ! command -v rustc &>/dev/null; then
    echo "Error: 未找到 Rust，请先安装: https://rustup.rs/" >&2
    exit 1
  fi
  echo "  Rust     $(rustc --version)"

  if ! command -v npm &>/dev/null; then
    echo "Error: 未找到 npm，请确认 Node.js 安装完整。" >&2
    exit 1
  fi
  echo "  环境检查通过"
fi

# ============================================================
# 2. 安装前端依赖
# ============================================================

echo "[2/4] 安装前端依赖..."
pushd "$DESKTOP_DIR" > /dev/null
if [[ ! -d "node_modules" ]]; then
  npm install
else
  echo "  node_modules 已存在，跳过安装"
fi

# ============================================================
# 3. Tauri 构建
# ============================================================

echo "[3/4] 正在构建桌面应用（首次构建可能需要几分钟）..."
npm run tauri:build:mac
popd > /dev/null

# ============================================================
# 4. 收集产物到 dist/
# ============================================================

echo "[4/4] 收集安装包到 dist/ ..."

# 读取版本号
VERSION=$(node -e "console.log(require('$DESKTOP_DIR/package.json').version)")
PRODUCT_NAME="时光手帐"

mkdir -p "$DIST_DIR"

# 查找 .app 和 .dmg
APP_BUNDLE=""
DMG_FILE=""

TAURI_BUNDLE_DIR="$DESKTOP_DIR/src-tauri/target/release/bundle"
if [[ -d "$TAURI_BUNDLE_DIR" ]]; then
  APP_BUNDLE="$(find "$TAURI_BUNDLE_DIR/macos" -name "*.app" -maxdepth 1 2>/dev/null | head -1)"
  DMG_FILE="$(find "$TAURI_BUNDLE_DIR/dmg" -name "*.dmg" -maxdepth 1 2>/dev/null | head -1)"
fi

if [[ -n "$APP_BUNDLE" ]]; then
  APP_NAME="$(basename "$APP_BUNDLE")"
  cp -R "$APP_BUNDLE" "$DIST_DIR/"
  echo "  已生成: $APP_NAME"
fi

if [[ -n "$DMG_FILE" ]]; then
  DMG_NAME="${PRODUCT_NAME}.${VERSION}.dmg"
  cp "$DMG_FILE" "$DIST_DIR/$DMG_NAME"
  echo "  已生成: $DMG_NAME"
fi

# 绿色版 zip
RELEASE_BIN="$DESKTOP_DIR/src-tauri/target/release/lifeos-morning-journal"
if [[ -x "$RELEASE_BIN" ]]; then
  PORTABLE_NAME="${PRODUCT_NAME}.${VERSION}.Portable.zip"
  pushd "$(dirname "$RELEASE_BIN")" > /dev/null
  zip -r "$DIST_DIR/$PORTABLE_NAME" "$(basename "$RELEASE_BIN")" -x '*.d' 2>/dev/null
  popd > /dev/null
  echo "  已生成: $PORTABLE_NAME（绿色免安装版）"
fi

echo ""
echo "=== 构建完成 ==="
echo "产物目录: $DIST_DIR"
echo ""

# 自动打开 dist 文件夹
open "$DIST_DIR"
