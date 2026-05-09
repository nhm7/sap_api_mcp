# sap-api-mcp

MCP server for the [SAP Business Accelerator Hub](https://api.sap.com) — search APIs, list package contents, and inspect full specifications (OData EDMX, REST OpenAPI, SOAP WSDL) directly from Claude.

## Prerequisites

| Requirement | Details |
|---|---|
| **Node.js 22+** | Uses native `WebSocket` global. [Download](https://nodejs.org) |
| **Chromium browser** | Required only for `login`. Chrome, Edge, Brave, or Chromium on Mac / Linux / Windows. |

---

## Installation

### Claude Code (recommended)

Run once in your terminal to register the server at user scope:

```bash
claude mcp add --scope user sap-api-mcp -- npx -y github:nhm7/sap_api_mcp
```

That's it. Claude Code picks it up immediately — no restart needed.

### Claude Desktop

Add to your config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sap-api-mcp": {
      "command": "npx",
      "args": ["-y", "github:nhm7/sap_api_mcp"]
    }
  }
}
```

### Pre-built archive (no npx)

Each [GitHub Release](https://github.com/nhm7/sap_api_mcp/releases) ships a `sap-api-mcp.tar.gz` with `index.js` and all production dependencies pre-bundled — no `npm install` needed.

```bash
# Download and extract
curl -L https://github.com/nhm7/sap_api_mcp/releases/latest/download/sap-api-mcp.tar.gz | tar xz

# Register with Claude Code
claude mcp add --scope user sap-api-mcp -- node /absolute/path/to/sap-api-mcp/index.js
```

---

## Tools

### `login`
Opens Chrome/Edge/Brave, lets you sign in to api.sap.com, then closes the browser automatically once the session is detected.  
Session cookies are saved to `~/.sap-api-mcp/cookies.json` and reused until they expire.

> Required for `get_spec` on REST, SOAP, and GraphQL APIs.

### `search_apis`
Keyword search across the entire catalog. No login required.

| Parameter | Type | Description |
|---|---|---|
| `searchTerm` *(required)* | string | Keyword, e.g. `"sales order"`. Use `"*"` to list everything. |
| `packageName` | string | Filter by package technical name, e.g. `"SAPS4HANACloud"`. |
| `apiType` | enum | `SOAP` · `ODATA` · `ODATAV4` · `REST` · `GRAPHQL` |
| `top` | number | Max results (default 20, max 50). |

### `list_apis`
All APIs within a specific product package. No login required.

| Parameter | Type | Description |
|---|---|---|
| `packageName` *(required)* | string | Package technical name, e.g. `"SAPS4HANACloud"`. |
| `apiType` | enum | Same values as above. |
| `top` | number | Max results (default 50, max 100). |

### `get_spec`
Downloads and parses the full spec for any API.

| Parameter | Type | Description |
|---|---|---|
| `apiName` *(required)* | string | Technical API name, e.g. `"API_BUSINESS_PARTNER"`. Use `search_apis` or `list_apis` to find it. |

Returns:
- **OData** → entity types, key fields, all properties with SAP labels and types
- **REST** → all endpoints, path/query/body parameters, response schemas (OpenAPI)
- **SOAP** → operations, message parts and element types (WSDL)

---

## Login workflow

```
Claude calls login
  → browser opens at api.sap.com
  → you sign in normally (SSO, username/password, etc.)
  → session is detected automatically
  → browser closes, cookies saved
  → get_spec now works for all API types
```

Cookies are stored **locally only** — never committed to git or sent anywhere.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| *"No Chromium-based browser found"* | Install [Chrome](https://google.com/chrome), [Edge](https://microsoft.com/edge), or [Brave](https://brave.com). |
| *"Login timed out after 2 minutes"* | Call `login` again and complete sign-in within 2 minutes of the browser opening. |
| *"API not found (404)"* | Use `search_apis` to find the correct technical name — display names won't work. |
| `get_spec` returns `login_required` | Call `login` first, then retry. |
| Session expired | Call `login` again to refresh the saved cookies. |

---

## License

MIT
