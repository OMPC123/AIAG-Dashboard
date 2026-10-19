# AIAG Dashboard

[繁體中文說明](README.zh-TW.md)

A desktop dashboard for people who run AI coding agents. It shows **Claude** (any number of accounts) and **Antigravity** side by side: whether each agent is working, plan usage, token usage and recent sessions.

Everything is read from files those apps already write on your computer. No API keys, no sign-in, and nothing is sent anywhere unless you turn on sharing between your own computers.

- **Claude**: 5-hour and 7-day plan usage per account (with history), live session status (working / idle), tokens in/out/cache per day and per hour, recent sessions with project and model.
- **Antigravity**: app status, conversations and agent steps, and (optional) remaining model quota.
- **Compact view**: one row per account, so it fits as a small always-on-top widget. **Full view**: charts and session lists.
- **Several computers**: run it on each machine and see them all in one window.
- Windows, macOS and Linux. English and Traditional Chinese (follows the system language).

## Install

Download the latest build from **Releases**:

| System | File |
|---|---|
| Windows | `AIAG-Dashboard-x.y.z-win-x64-setup.exe` (installer) or `…-win-portable.exe` (no install) |
| macOS, Apple Silicon (M1–M4) | `AIAG-Dashboard-x.y.z-mac-arm64.dmg` |
| macOS, Intel | `AIAG-Dashboard-x.y.z-mac-x64.dmg` |
| Linux | `AIAG-Dashboard-x.y.z-linux-x86_64.AppImage` |

The builds are not code-signed, so the first launch shows a warning:

- **Windows**: SmartScreen says “Windows protected your PC” → *More info* → *Run anyway*.
- **macOS**: open the app once with right-click → *Open* → *Open*. If macOS says the app “is damaged”, run `xattr -cr "/Applications/AIAG Dashboard.app"` in Terminal, then open it again.

### Run from source

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/OMPC123/AIAG-Dashboard.git
cd AIAG-Dashboard
npm install
npm start
```

Shortcuts for later: double-click `AIAG Dashboard.bat` (Windows) or `AIAG Dashboard.command` (macOS).

## Using it

- **簡化 / 完整 (Compact / Full)** in the toolbar switches views. Each view remembers its own window size.
- **📌** keeps the window on top. **↻** refreshes now (it also refreshes every 10 s).
- Closing the window keeps it running in the tray / menu bar: green dot = an agent is working, blue = idle, grey = nothing running. Right-click the icon to quit.
- **⚙ Settings**: language, refresh interval, which sources to show, display names for accounts, and sharing between computers. Settings are saved immediately and kept across restarts.

## Where the data comes from

| What | Where (Windows / macOS) |
|---|---|
| Claude plan usage % (5-hour, 7-day) per account | Claude desktop app: `%APPDATA%\Claude\plan-usage-history.json` / `~/Library/Application Support/Claude/plan-usage-history.json` |
| Which session belongs to which account | Claude desktop app: `…/Claude/claude-code-sessions/` |
| Live session status | Claude Code: `~/.claude/sessions/` |
| Token usage | Claude Code transcripts: `~/.claude/projects/**/*.jsonl` (last 14 days) |
| Account email / organization | `~/.claude.json` |
| Antigravity conversations and steps | `~/.gemini/antigravity/conversation_summaries.db` (read-only) |
| Antigravity model quota (optional) | The Antigravity app running locally, queried on 127.0.0.1 only |

Notes:

- Plan usage % is recorded by the **Claude desktop app** while you are signed in to that account. Accounts used only through the Claude Code CLI show sessions and tokens but no plan %.
- Token counts cover Claude Code on this computer. Chats on claude.ai in a browser are not stored locally and are not counted.
- If you sign Claude Code into another account with `CLAUDE_CONFIG_DIR`, add that folder under *Settings → Sources → Advanced*.
- Antigravity does not store token counts locally, so activity is shown as conversations and agent steps.

## Several computers

Each computer can only read its own files, so run the dashboard on every computer you use.

1. On the computer you want to **read from**: *Settings → Multiple computers → Share this computer's data*, then *Save*. Copy the **connection code** (`aiag1:…`).
2. On the computer you **look at**: paste the code under *Other computers to read from* → *Add* → *Save*.

Both must be on the same network (or a VPN such as Tailscale). Sharing is read-only, protected by the token inside the code, and only sends counts, session titles and project folder names, never conversation content. *Regenerate* invalidates the old code.

### If it can't connect

- **Windows Firewall**: when the network is set to *Public*, Windows does not ask and simply blocks it. In an **administrator** PowerShell:

  ```powershell
  New-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)" -Direction Inbound -Protocol TCP -LocalPort 47821 -RemoteAddress LocalSubnet -Action Allow -Profile Any
  ```

  To remove it later: `Remove-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)"`
- **macOS Firewall**: *System Settings → Network → Firewall → Options*, allow incoming connections for AIAG Dashboard.
- A sleeping laptop shows as *offline*; its last data stays visible.
- Test the port: `nc -vz <ip> 47821` (macOS/Linux) or `Test-NetConnection <ip> -Port 47821` (Windows).

## Antigravity model quota (experimental)

Off by default. When enabled, the dashboard reads the CSRF token from the command line of the locally running Antigravity language server and asks it, on 127.0.0.1, for the signed-in account's remaining quota. The token is not stored and nothing leaves the computer. Models that share one quota pool are shown as a single row.

## Settings file

`%APPDATA%\aiag-dashboard\settings.json` (Windows), `~/Library/Application Support/aiag-dashboard/settings.json` (macOS), `~/.config/aiag-dashboard/settings.json` (Linux). If it ever becomes unreadable, it is kept as `settings.json.broken-<time>` and defaults are used.

## Development

```bash
npm start           # run
npm run check       # print what the collectors find on this machine
npm test            # sharing / connection-code tests
npm run dist:win    # build installers into dist/ (also dist:mac, dist:linux)
```

Releases: push a tag such as `v0.2.0`. GitHub Actions builds Windows, macOS and Linux and attaches them to a **draft** release; publish it from the Releases page.
