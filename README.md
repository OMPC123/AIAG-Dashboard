# AIAG Dashboard

桌面版 AI Agent 監控面板：同時顯示多個 Claude 帳號與 Antigravity 的工作狀態、方案用量與 token 用量。資料都從各電腦的本機檔案讀取，不需要 API 金鑰，也不會連到外部伺服器；多台電腦可以透過區網互相分享。

## 啟動

雙擊 `AIAG Dashboard.bat`（第一次會自動 `npm install`），或：

```bash
npm start
```

關閉視窗會縮到系統匣（綠點＝有 agent 工作中、藍點＝閒置、灰點＝都沒在跑），右鍵系統匣圖示可結束。

## 顯示內容與資料來源

| 項目 | 來源 |
|---|---|
| Claude 各帳號 5 小時 / 7 天方案用量 % 與歷史 | `%APPDATA%\Claude\plan-usage-history.json`（Claude 桌面版定期記錄，每個 org 一組） |
| 帳號與 session 對應 | `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_*.json` |
| Session 工作狀態（工作中 / 閒置） | `~/.claude/sessions/*.json` ＋ 程序是否存活 |
| Token 用量（輸入 / 輸出 / 快取） | `~/.claude/projects/**/*.jsonl`，以增量方式解析 |
| 帳號資訊（email、組織） | `~/.claude.json` |
| Antigravity 對話、狀態、步驟數 | `~/.gemini/antigravity/conversation_summaries.db`（唯讀） |
| Antigravity 模型配額（選用，預設關閉） | 本機 Antigravity language server（僅 127.0.0.1） |

## 設定

右上角「⚙ 設定」：

- **帳號顯示名稱**：幫每個 Claude 帳號取名字。
- **額外的 Claude Code 設定目錄**：如果另一個帳號是用 `CLAUDE_CONFIG_DIR=...` 登入 Claude Code CLI，把那個目錄加進來，就能讀到它的 session 與 token。
- **Antigravity 讀取模型配額**：從執行中的 language server 程序參數取得 CSRF token，向 127.0.0.1 查詢剩餘配額。屬實驗性功能。

設定檔存放於 `%APPDATA%\aiag-dashboard\settings.json`。

## 兩台電腦（例如第 2 個 Claude 帳號在另一台電腦）

每台電腦都只讀得到自己的本機紀錄，所以兩台都要執行這個 Dashboard。支援 Windows 和 macOS。

### 在 Mac 上從 GitHub 下載（私人儲存庫）

在「終端機」執行（需要 Homebrew；沒有的話先到 https://brew.sh 安裝）：

```bash
brew install node gh
gh auth login            # 選 GitHub.com → HTTPS → Login with a web browser
gh repo clone <你的帳號>/<儲存庫名稱> ~/AIAG_Dashboard
cd ~/AIAG_Dashboard && npm install && npm start
```

之後可以在 Finder 雙擊 `~/AIAG_Dashboard/AIAG Dashboard.command` 啟動。要更新到最新版時，執行：

```bash
cd ~/AIAG_Dashboard && git pull && npm install
```

1. 把整個資料夾複製到第二台電腦，**不要**複製 `node_modules`（裡面是 Windows 版的 Electron，第二台會自動重新安裝）。第二台需要先安裝 Node.js。
   - Windows：雙擊 `AIAG Dashboard.bat`。
   - macOS（例如 MacBook Air）：先在「終端機」進入資料夾，執行一次 `chmod +x "AIAG Dashboard.command"`，之後就可以在 Finder 雙擊 `AIAG Dashboard.command` 啟動。也可以直接執行 `npm install && npm start`。
2. 在**第二台**：⚙ 設定 → 多台電腦 → 勾選「分享這台電腦的資料」→ 儲存。防火牆詢問時要允許：Windows 選「私人網路」；macOS 出現「是否允許 Electron 接受連入連線」時按「允許」。再次打開設定，複製畫面上顯示的網址（例如 `http://192.168.1.20:47821`）和 token。
3. 在**主要那台**：⚙ 設定 → 多台電腦 →「要讀取的其他電腦」填一行 `辦公室電腦 | http://192.168.1.20:47821 | <token>` → 儲存。

之後主畫面會把兩台電腦的帳號放在一起顯示，每張卡片標示來源電腦。連不到遠端時會顯示「離線」，並保留上次取得的資料。

- 分享是唯讀的：只提供 `GET /api/snapshot`，而且要帶正確的 token。內容只有統計數字、session 標題與專案資料夾名稱，不包含對話內容。
- 各台電腦只分享自己本機的資料，所以兩台互相讀取也不會重複計算。
- 兩台電腦需要在同一個區網或 VPN 內（例如 Tailscale）。
- MacBook 闔上螢幕或進入睡眠時就連不到，畫面會顯示「離線」並保留上次的資料。Mac 的 IP 若會變動，可以在路由器設定固定 IP，或改填 `http://<電腦名稱>.local:47821`。

### macOS 上的資料位置

| 項目 | 路徑 |
|---|---|
| Claude 桌面版（方案用量、帳號對應） | `~/Library/Application Support/Claude/` |
| Claude Code（session、token） | `~/.claude/`、`~/.claude.json` |
| Antigravity | `~/.gemini/antigravity/` |
| 本 Dashboard 設定檔 | `~/Library/Application Support/aiag-dashboard/settings.json` |

## 檢查收集器

```bash
npm run check
```

```bash
node scripts/test-remote.js
```

## 限制

- Claude 方案用量 % 只有在 Claude 桌面版登入該帳號時才會更新；畫面上會顯示取樣時間。
- Token 數只統計「這台電腦」上的 Claude Code 紀錄；claude.ai 網頁對話不在本機，無法計入。
- Antigravity 本機不保存 token 數，因此以對話數與 agent 步驟數代表活動量。
