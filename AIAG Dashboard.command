#!/bin/zsh
# macOS launcher: double-click in Finder.
# Finder starts this without the PATH from ~/.zprofile, so Homebrew / nvm Node must be added by hand.
cd "${0:A:h}" || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

pause_and_exit() {
  echo
  read -r "?按 Enter 關閉…"
  exit 1
}

if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 Node.js。請先在終端機執行：brew install node"
  pause_and_exit
fi

if [ ! -x node_modules/.bin/electron ]; then
  echo "正在安裝相依套件（第一次需要 1～2 分鐘）…"
  npm install || { echo "安裝失敗，請把上面的訊息截圖。"; pause_and_exit; }
fi

LOG="$HOME/Library/Logs/aiag-dashboard.log"
mkdir -p "${LOG:h}"
echo "啟動 AIAG Dashboard…（紀錄檔：$LOG）"
nohup ./node_modules/.bin/electron . >"$LOG" 2>&1 &
disown

# Give it a few seconds; if it died, show why instead of silently closing.
sleep 4
if ! kill -0 $! 2>/dev/null; then
  echo "AIAG Dashboard 沒有成功啟動，錯誤訊息："
  tail -n 30 "$LOG"
  pause_and_exit
fi
echo "已啟動，可以關閉這個視窗。"
