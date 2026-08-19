#!/usr/bin/env bash
# 一键启动 LifeOS 桌面应用（macOS 开发模式）。
#
# Usage:
#   ./run.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$REPO_ROOT/desktop"

if ! command -v npm &>/dev/null; then
  echo "Error: 未找到 npm。请先安装 Node.js: https://nodejs.org/" >&2
  exit 1
fi

pushd "$DESKTOP_DIR" > /dev/null
if [[ ! -d "node_modules" ]]; then
  echo "首次运行，正在安装依赖..."
  npm install
fi
npm run tauri:dev:mac 2>/dev/null || npx tauri dev --no-dev-server
popd > /dev/null
