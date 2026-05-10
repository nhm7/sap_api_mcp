## 2026-05-10 - Secure Cookie Storage
**Vulnerability:** The application was storing sensitive SAP session cookies in `~/.sap-api-mcp/cookies.json` without explicit file permission constraints. This could potentially allow other users on the host system to read these credentials.
**Learning:** Node.js file operations `mkdirSync` and `writeFileSync` create files using the default umask, which can lead to overly permissive setups.
**Prevention:** Always provide the `mode` option explicitly for sensitive file or directory creation (e.g. `mode: 0o700` for dirs and `mode: 0o600` for files).
