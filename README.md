# AIAG Dashboard

[繁體中文說明](README.zh-TW.md)

A desktop dashboard for people who run AI coding agents. It shows **Claude** and **Antigravity** side by side, across all your computers: whether each agent is working, plan usage, token usage and recent sessions.

Everything is read from files those apps already write on your computer. No API keys, no sign-in, and nothing is sent anywhere unless you turn on sharing between your own computers.

- **Claude**: 5-hour and 7-day plan usage per account (with history), live session status (working / idle), tokens in/out/cache per day and per hour, recent sessions with project and model.
- **Antigravity**: app status, conversations and agent steps, and (optional) remaining model quota.
- **Compact view**: one row per account, so it fits as a small always-on-top widget. **Full view**: charts and session lists.
- **Several computers**: run it on each machine and see them all in one window; IP address changes are handled automatically.
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
- **macOS**: drag the app into *Applications* first (don't run it from the mounted DMG). macOS then says it can't verify the developer. Run this once in Terminal, and the app opens with a normal double-click from then on:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/AIAG Dashboard.app"
  ```

  Run it again after installing a new version. (Without Terminal: try to open the app, then go to *System Settings → Privacy & Security* and click *Open Anyway*. That button only shows for about an hour after the blocked attempt.)

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

## Accounts

*Settings → Accounts* lists the accounts found on this computer: the Claude account(s) the Claude desktop app and Claude Code have used, and the account signed in to Antigravity. You can give each one a display name or hide it from the dashboard. Accounts on other computers are managed on those computers.

The dashboard does not sign in to anything itself: one computer runs one Claude account at a time, so to watch a second account, run the dashboard on the computer that uses it and add that computer (see *Several computers*).

An account with no usage data (for example a free-plan account, which Claude reports no usage % for, and which has no Claude Code activity) gets a short card saying so, with the last time it was used in the Claude desktop app.

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
- To watch a Claude account used on another computer, add that computer (see *Several computers*).
- Antigravity does not store token counts locally, so activity is shown as conversations and agent steps.

## Several computers

Each computer can only read its own files, so run the dashboard on every computer you use.

1. On the computer you want to **read from**: *Settings → Multiple computers → Share this computer's data*, then *Save*. Copy the **connection code** (`aiag1:…`).
2. On the computer you **look at**: paste the code under *Other computers to read from* → *Add* → *Save*.

Both must be on the same network (or a VPN such as Tailscale). Sharing is read-only and protected by the token inside the code; see *Security and privacy* for exactly what is sent. *Regenerate* invalidates the old code.

**IP address changes** (e.g. a laptop getting a new address from the router) are handled automatically. When a computer stops answering at every known address, the dashboard probes the local network on the share port in the background. Only the computer that accepts the code's token, and has the same computer ID, is accepted. Its new address is saved, so the next refresh and later restarts use it. A computer that stays away (asleep, switched off) is re-checked with growing intervals, from 1 to 10 minutes. The connection code also contains the computer's name (`<name>.local`), which keeps working across IP changes on most home and office networks.

### If it can't connect

- **Windows Firewall**: when the network is set to *Public*, Windows does not ask and simply blocks it. In an **administrator** PowerShell:

  ```powershell
  New-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)" -Direction Inbound -Protocol TCP -LocalPort 47821 -RemoteAddress LocalSubnet -Action Allow -Profile Any
  ```

  To remove it later: `Remove-NetFirewallRule -DisplayName "AIAG Dashboard (TCP 47821)"`
- **macOS Firewall**: *System Settings → Network → Firewall → Options*, allow incoming connections for AIAG Dashboard.
- A sleeping laptop shows as *offline*; its last data stays visible.
- Test the port: `nc -vz <ip> 47821` (macOS/Linux) or `Test-NetConnection <ip> -Port 47821` (Windows).

## Security and privacy

- **No network use by default.** Everything is read from local files. Nothing is uploaded; there is no telemetry and no auto-update.
- **Sharing is off by default** and read-only. When on, the share server listens on the port you choose (47821). Only requests carrying the token from the connection code get data.
- **What is shared:** account email / display name / organization name, plan %, token counts, session titles, project *folder names* (not full paths), model names, Antigravity conversation titles and quota. Never conversation content, files, or settings.
- **The token is never sent to an unverified address.** Before sending it, the dashboard asks the address to prove it knows the token (HMAC over a random challenge). LAN rediscovery after an IP change uses only these challenges. A computer on version 0.4.0 or earlier can't answer them; it is still trusted at the addresses from its own code, until it has answered a challenge once.
- **Traffic between computers is plain HTTP.** Someone who can watch your network traffic could read the shared numbers and the token. Use sharing only on networks you trust, or over a VPN such as Tailscale. Use *Regenerate* if a code may have leaked.
- **LAN rediscovery** sends one small challenge request to each address on your subnet when a computer goes missing (at most every 1–10 minutes). Turn it off under *Settings → Multiple computers* on networks where scanning isn't allowed.
- **Antigravity quota (opt-in)** reads a token from the local Antigravity process's command line and talks only to `127.0.0.1`.
- **Data from other computers is treated as untrusted**: it is escaped before display, numbers are checked, and the window is locked to the app page (Content-Security-Policy, no navigation, no new windows).

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
