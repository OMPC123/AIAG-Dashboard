# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub: go to the **Security** tab of this repository and click **Report a vulnerability**. Include what you found, how to reproduce it, and which version you used. I'll reply as soon as I can, and credit you in the release notes if you like.

## Supported versions

Only the latest release gets security fixes. Please update before reporting.

## Scope

AIAG Dashboard reads local files and, only if you turn on sharing, serves a read-only snapshot to your other computers on the local network. Issues that are especially relevant:

- the LAN share server and the connection-code / token handling (`src/remote.js`);
- anything that lets data from another computer run code or open files in the app (`src/renderer/`, `src/main.js`);
- the optional Antigravity quota reader (`src/collectors/antigravity.js`).

Known limitation: traffic between computers is plain HTTP, so someone who can watch your network traffic can read the shared data and the token. See *Security and privacy* in the README.

---

## 回報安全性問題

請**不要開公開的 issue**。請到這個儲存庫的 **Security** 分頁，按 **Report a vulnerability** 私下回報，並附上問題描述、重現步驟和使用的版本。只有最新版本會收到安全性修正。
