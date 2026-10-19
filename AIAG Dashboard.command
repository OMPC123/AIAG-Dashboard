#!/bin/bash
# macOS launcher: double-click in Finder (run `chmod +x "AIAG Dashboard.command"` once after copying).
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 Node.js，請先安裝：https://nodejs.org/ 或 brew install node"
  read -r -p "按 Enter 關閉…"
  exit 1
fi
if [ ! -x node_modules/.bin/electron ]; then
  echo "正在安裝相依套件…"
  npm install || { read -r -p "安裝失敗，按 Enter 關閉…"; exit 1; }
fi
nohup ./node_modules/.bin/electron . >/dev/null 2>&1 &
osascript -e 'tell application "Terminal" to close (every window whose name contains "AIAG Dashboard")' >/dev/null 2>&1 &
exit 0
