# sap-api-mcp

MCP server for the [SAP Business Accelerator Hub](https://api.sap.com) — search APIs, list package contents, and inspect full specifications (OData EDMX, REST OpenAPI, SOAP WSDL) directly from Claude.

## Prerequisites

| Requirement | Details |
|---|---|
| **Node.js 22+** | Uses native `WebSocket` global. [Download](https://nodejs.org) |
| **Chromium browser** | Required only for `login`. Chrome, Edge, Brave, or Chromium on Mac / Linux / Windows. |

---

## Option 1 — npx (no installation)

The easiest way. Claude downloads and runs the server on demand via `npx`.

Add to your Claude user-scope config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "sap-api-mcp": {
      "command": "npx",
      "args": ["-y", "sap-api-mcp@latest"]
    }
  }
}
```

> **Claude Desktop** users: edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) with the same `mcpServers` block.

---

## Option 2 — local clone

```bash
git clone https://github.com/nhm7/sap_api_mcp.git
cd sap_api_mcp
npm install
```

Then add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "sap-api-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/sap_api_mcp/index.js"]
    }
  }
}
```

---

## Option 3 — pre-built release archive

Each [GitHub Release](https://github.com/nhm7/sap_api_mcp/releases) ships a `sap-api-mcp-vX.Y.Z.tar.gz` that contains `index.js` and all production dependencies pre-bundled — no `npm install` needed.

```bash
# Download and extract
curl -L https://github.com/nhm7/sap_api_mcp/releases/latest/download/sap-api-mcp.tar.gz | tar xz
cd sap-api-mcp

# Add to Claude (same as Option 2, just update the path)
```

---

## Tools

### `login`
Opens Chrome/Edge/Brave, lets you sign in to api.sap.com, then closes the browser automatically once the session is detected.  
Session cookies are saved to `~/.sap-api-mcp/cookies.json` and reused until they expire.

> Required for `get_spec` on REST, SOAP, and GraphQL APIs.  
> OData APIs work without login if you set `SAP_API_KEY` env var (see below).

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

## Optional: API Key for OData without login

You can skip `login` for OData APIs by setting `SAP_API_KEY` in the MCP server config:

```json
{
  "mcpServers": {
    "sap-api-mcp": {
      "command": "npx",
      "args": ["-y", "sap-api-mcp@latest"],
      "env": {
        "SAP_API_KEY": "your-key-here"
      }
    }
  }
}
```

Get a free key at [api.sap.com](https://api.sap.com) → Settings → API Key.  
REST, SOAP, and GraphQL specs always require `login` regardless of the API key.

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
