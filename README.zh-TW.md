# AIAG Dashboard

[English](README.md)

給使用 AI coding agent 的人用的桌面監控面板。它把 **Claude** 和 **Antigravity**（包含你所有電腦）放在同一個畫面上，顯示每個 agent 是否在工作、方案用量、token 用量和最近的 session。

所有資料都是讀取這些 App 原本就寫在你電腦上的檔案。不需要 API 金鑰，也不用登入。除非你自己開啟「多台電腦分享」，否則資料不會傳到任何地方。

- **Claude**：每個帳號的 5 小時／7 天方案用量（含歷史）、session 即時狀態（工作中／閒置）、每日與每小時的輸入／輸出／快取 tokens，以及最近的 session（含專案與模型）。
- **Antigravity**：App 狀態、對話與 agent 步驟數，以及（選用）各模型的剩餘配額。
- **簡化模式**：每個帳號一列，適合縮成小視窗並置頂。**完整模式**：圖表和 session 清單。
- **多台電腦**：每台都執行，就能在同一個視窗看到所有電腦；IP 變動時會自動重新連上。
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
- **macOS**：請先把 App 拖進「應用程式」，不要直接從掛載的 DMG 執行。macOS 會提示無法驗證開發者，這時在「終端機」執行一次下面的指令，之後就能直接雙擊開啟：

  ```bash
  xattr -dr com.apple.quarantine "/Applications/AIAG Dashboard.app"
  ```

  每次安裝新版後要再執行一次。如果不想用終端機，也可以先嘗試開啟 App，再到「系統設定 → 隱私權與安全性」按「強制打開」；但這個按鈕只會在嘗試開啟後約一小時內出現。

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

「設定 → 帳號」會列出在這台電腦上偵測到的帳號，包括 Claude 桌面版和 Claude Code 用過的 Claude 帳號，以及 Antigravity 目前登入的帳號。每個帳號都可以設定顯示名稱，或在 Dashboard 上隱藏。其他電腦上的帳號，請在那台電腦上管理。

Dashboard 本身不會登入任何帳號。一台電腦同一時間只會使用一個 Claude 帳號，所以想同時查看第二個帳號，請在使用該帳號的電腦上執行 Dashboard，再把那台電腦加進來（見「多台電腦」）。

沒有用量數據的帳號會改用精簡卡片，並顯示它最後一次在 Claude 桌面版使用的時間。例如免費方案帳號：官方不提供它的用量 %，它也沒有 Claude Code 活動。

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
- 要查看另一台電腦上使用的 Claude 帳號，請把那台電腦加進來（見「多台電腦」）。
- Antigravity 本機不保存 token 數，所以用對話數和 agent 步驟數表示活動量。

## 多台電腦

每台電腦只讀得到自己的檔案，所以每台要看的電腦都需要執行這個 Dashboard。

1. 在**要被讀取**的電腦：「設定 → 多台電腦 → 分享這台電腦的資料」→ 儲存，然後複製畫面上的**連線碼**（`aiag1:…`）。
2. 在**要看資料**的電腦：把連線碼貼到「要讀取的其他電腦」→ 新增 → 儲存。

兩台電腦需要在同一個網路，或透過 VPN（例如 Tailscale）互通。分享是唯讀的，並以連線碼裡的 token 保護；實際傳送哪些內容，請見「安全與隱私」。按「重新產生」後，舊的連線碼就會失效。

**IP 變動**（例如筆電從路由器拿到新的 IP）會自動處理。當另一台電腦在所有已知位址都沒有回應時，Dashboard 會在背景掃描區網中的分享連接埠。只有接受連線碼裡的 token、而且電腦 ID 相同的那一台才會被採用。找到後會記住新位址，下次更新和重新開啟都會直接使用。如果那台電腦一直不在（睡眠或關機），重新尋找的間隔會從 1 分鐘逐步拉長到 10 分鐘。連線碼也包含電腦名稱（`<名稱>.local`），在大多數家用和辦公室網路中，IP 改變後仍能用這個名稱連線。

### 連不上時

- **Windows 防火牆**：如果網路被設為「公用」，Windows 不會詢問，而是直接阻擋連入。請用**系統管理員身分**開啟 PowerShell 執行：

  ```powershell
  New-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)" -Direction Inbound -Protocol TCP -LocalPort 47821 -RemoteAddress LocalSubnet -Action Allow -Profile Any
  ```

  不需要時可以移除：`Remove-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)"`
- **macOS 防火牆**：「系統設定 → 網路 → 防火牆 → 選項」，允許 AIAG Dashboard 接受連入連線。
- 筆電睡眠時會顯示「離線」，並保留上次取得的資料。
- 測試連接埠：`nc -vz <IP> 47821`（macOS／Linux）或 `Test-NetConnection <IP> -Port 47821`（Windows）。

## 安全與隱私

- **預設完全不用網路。** 所有資料都從本機檔案讀取。不會上傳任何東西，沒有遙測，也沒有自動更新。
- **分享預設關閉**，而且是唯讀的。開啟後，分享伺服器會在你選的連接埠（47821）上監聽，只有帶著連線碼裡 token 的請求才拿得到資料。
- **分享的內容**：帳號 email／顯示名稱／組織名稱、方案用量 %、token 數、session 標題、專案**資料夾名稱**（不含完整路徑）、模型名稱、Antigravity 對話標題與配額。不包含對話內容、檔案或設定。
- **token 不會送到未經驗證的位址。** 送出 token 之前，Dashboard 會先要求對方證明它知道 token（以隨機挑戰值計算 HMAC）。IP 變動後的區網重新尋找，也只會送出這種挑戰請求。0.4.0 以前的版本無法回應挑戰：在它連線碼裡的位址上仍會被信任，但只要它回應過一次挑戰，之後就不再走這條路。
- **電腦之間的連線是未加密的 HTTP。** 能監看你網路流量的人，可以看到分享的數字和 token。請只在信任的網路上使用分享，或透過 VPN（例如 Tailscale）。如果連線碼可能外洩，請按「重新產生」。
- **區網重新尋找**：有電腦找不到時，會向子網路中的每個位址送出一個小型挑戰請求，頻率最多每 1～10 分鐘一次。在不允許掃描的網路，可以在「設定 → 多台電腦」關閉。
- **Antigravity 配額（需自行開啟）**：從本機 Antigravity 程序的參數讀取一個 token，只連線到 `127.0.0.1`。
- **其他電腦傳來的資料一律視為不可信**：顯示前會先跳脫、數字會檢查，視窗也鎖定在 App 頁面（Content-Security-Policy、禁止跳轉、禁止開新視窗）。

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
