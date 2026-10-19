# AIAG Dashboard

[English](README.md)

給使用 AI coding agent 的人用的桌面監控面板。它把 **Claude**（帳號數量不限）和 **Antigravity** 放在同一個畫面上，顯示每個 agent 是否在工作、方案用量、token 用量和最近的 session。

所有資料都是讀取這些 App 原本就寫在你電腦上的檔案。不需要 API 金鑰，也不用登入。除非你自己開啟「多台電腦分享」，否則資料不會傳到任何地方。

- **Claude**：每個帳號的 5 小時／7 天方案用量（含歷史）、session 即時狀態（工作中／閒置）、每日與每小時的輸入／輸出／快取 tokens，以及最近的 session（含專案與模型）。
- **Antigravity**：App 狀態、對話與 agent 步驟數，以及（選用）各模型的剩餘配額。
- **簡化模式**：每個帳號一列，適合縮成小視窗並置頂。**完整模式**：圖表和 session 清單。
- **多台電腦**：每台都執行，就能在同一個視窗看到所有電腦。
- 支援 Windows、macOS、Linux。介面有英文和繁體中文，預設跟隨系統語言。

## 安裝

到 **Releases** 下載最新版：

| 系統 | 檔案 |
|---|---|
| Windows | `AIAG-Dashboard-x.y.z-win-x64-setup.exe`（安裝版），或 `…-win-portable.exe`（免安裝） |
| macOS（Apple Silicon，M1–M4） | `AIAG-Dashboard-x.y.z-mac-arm64.dmg` |
| macOS（Intel） | `AIAG-Dashboard-x.y.z-mac-x64.dmg` |
| Linux | `AIAG-Dashboard-x.y.z-linux-x86_64.AppImage` |

安裝檔沒有程式碼簽章，所以第一次開啟時會出現警告：

- **Windows**：SmartScreen 顯示「Windows 已保護您的電腦」→ 按「其他資訊」→「仍要執行」。
- **macOS**：第一次請在 App 上按右鍵 →「打開」→「打開」。如果出現「已損毀」，在「終端機」執行 `xattr -cr "/Applications/AIAG Dashboard.app"` 後再打開。

### 從原始碼執行

需要 [Node.js](https://nodejs.org/) 20 以上。

```bash
git clone https://github.com/OMPC123/AIAG-Dashboard.git
cd AIAG-Dashboard
npm install
npm start
```

之後可以直接雙擊 `AIAG Dashboard.bat`（Windows）或 `AIAG Dashboard.command`（macOS）啟動。

## 使用方式

- 工具列的 **簡化／完整** 可以切換畫面；兩種模式各自記得自己的視窗大小。
- **📌** 讓視窗置頂。**↻** 立即更新；平常每 10 秒會自動更新。
- 關閉視窗後，程式會繼續在系統匣／選單列執行：綠點＝有 agent 在工作，藍點＝閒置，灰點＝都沒在跑。在圖示上按右鍵可以結束。
- **⚙ 設定**：語言、更新間隔、要顯示哪些來源、帳號顯示名稱、多台電腦分享。設定會立即儲存，重新開啟後仍然保留。

## 帳號

「設定 → 帳號」列出這台電腦上的所有帳號。每個帳號都可以改名、在 Dashboard 上隱藏，也可以新增帳號。

**新增 Claude 帳號**：輸入名稱（例如「工作」），按「新增並登入」。Dashboard 會為這個帳號建立獨立的 Claude Code 設定資料夾（`~/.claude-accounts/<名稱>`），並在終端機視窗開啟官方的 Claude Code 登入（`claude auth login`），你在瀏覽器中完成登入即可。Dashboard 不會看到你的密碼或 token；登入資料由 Claude Code 存在該資料夾裡（macOS 則存在鑰匙圈）。

每個新增的帳號都有這些按鈕：

- **開啟 Claude Code**：用這個帳號啟動 Claude Code。之後它的 session、token 和工作狀態就會出現在 Dashboard 上。
- **複製指令**：複製一行指令，在任何終端機貼上就能用這個帳號執行 Claude Code。
- **登出**、**資料夾**、**移除**：「移除」只會讓 Dashboard 忘記這個帳號，資料夾和裡面的登入資料仍保留在電腦上。
- **加入現有資料夾…**：把你原本就用 `CLAUDE_CONFIG_DIR` 使用的資料夾加進來。

登入需要 Claude Code。Dashboard 會依序到 PATH、常見的安裝位置，以及 Claude 桌面版內部尋找它。如果都找不到，「設定」裡會提供安裝說明的連結。

方案用量 %（5 小時／7 天）來自 Claude 桌面版，所以只有在桌面版登入過的帳號才看得到。只透過 Claude Code 使用的帳號，會顯示 session、token 和工作狀態。

Antigravity 是在 Antigravity App 裡用 Google 帳號登入，Dashboard 會列出該 App 目前使用的帳號。這個帳號也可以改名或隱藏。

## 資料來源

| 項目 | 位置（Windows／macOS） |
|---|---|
| Claude 各帳號方案用量 %（5 小時、7 天） | Claude 桌面版：`%APPDATA%\Claude\plan-usage-history.json`／`~/Library/Application Support/Claude/plan-usage-history.json` |
| session 屬於哪個帳號 | Claude 桌面版：`…/Claude/claude-code-sessions/` |
| session 即時狀態 | Claude Code：`~/.claude/sessions/` |
| Token 用量 | Claude Code 對話紀錄：`~/.claude/projects/**/*.jsonl`（近 14 天） |
| 帳號 email／組織 | `~/.claude.json` |
| Antigravity 對話與步驟 | `~/.gemini/antigravity/conversation_summaries.db`（唯讀） |
| Antigravity 模型配額（選用） | 本機執行中的 Antigravity，只查詢 127.0.0.1 |

補充說明：

- 方案用量 % 是由 **Claude 桌面版**在你登入該帳號時記錄的。只用 Claude Code CLI 的帳號會顯示 session 和 token，但沒有方案用量 %。
- Token 數只統計這台電腦上的 Claude Code。在瀏覽器裡用 claude.ai 的對話不會存在本機，所以不會計入。
- 要追蹤另一個 Claude 帳號，請到「設定 → 帳號」新增（見上方說明）。
- Antigravity 本機不保存 token 數，所以用對話數和 agent 步驟數表示活動量。

## 多台電腦

每台電腦只讀得到自己的檔案，所以每台要看的電腦都需要執行這個 Dashboard。

1. 在**要被讀取**的電腦：「設定 → 多台電腦 → 分享這台電腦的資料」→ 儲存，然後複製畫面上的**連線碼**（`aiag1:…`）。
2. 在**要看資料**的電腦：把連線碼貼到「要讀取的其他電腦」→ 新增 → 儲存。

兩台電腦需要在同一個網路，或透過 VPN（例如 Tailscale）互通。分享是唯讀的，以連線碼裡的 token 保護，傳送的內容只有統計數字、session 標題和專案資料夾名稱，不包含對話內容。按「重新產生」後，舊的連線碼就會失效。

### 連不上時

- **Windows 防火牆**：如果網路被設為「公用」，Windows 不會詢問，而是直接阻擋連入。請用**系統管理員身分**開啟 PowerShell 執行：

  ```powershell
  New-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)" -Direction Inbound -Protocol TCP -LocalPort 47821 -RemoteAddress LocalSubnet -Action Allow -Profile Any
  ```

  不需要時可以移除：`Remove-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)"`
- **macOS 防火牆**：「系統設定 → 網路 → 防火牆 → 選項」，允許 AIAG Dashboard 接受連入連線。
- 筆電睡眠時會顯示「離線」，並保留上次取得的資料。
- 測試連接埠：`nc -vz <IP> 47821`（macOS／Linux）或 `Test-NetConnection <IP> -Port 47821`（Windows）。

## Antigravity 模型配額（實驗性）

預設關閉。開啟後，Dashboard 會從本機執行中的 Antigravity language server 的程序參數讀取 CSRF token，然後透過 127.0.0.1 向它查詢目前登入帳號的剩餘配額。token 不會被儲存，資料也不會離開這台電腦。共用同一個配額的模型會合併成一列顯示。

## 設定檔位置

Windows：`%APPDATA%\aiag-dashboard\settings.json`
macOS：`~/Library/Application Support/aiag-dashboard/settings.json`
Linux：`~/.config/aiag-dashboard/settings.json`

如果設定檔損壞無法讀取，程式會把它另存成 `settings.json.broken-<時間>`，然後改用預設值。

## 開發

```bash
npm start           # 執行
npm run check       # 列出收集器在這台電腦找到的資料
npm test            # 分享／連線碼測試
npm run dist:win    # 在 dist/ 產生安裝檔（另有 dist:mac、dist:linux）
```

發佈新版：推送像 `v0.2.0` 這樣的 tag，GitHub Actions 會自動建置 Windows、macOS、Linux 版本，並附加到一個**草稿**版本。到 Releases 頁面確認後再按「Publish」。
