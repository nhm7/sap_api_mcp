# sap-api-mcp

MCP server for the [SAP Business Accelerator Hub](https://api.sap.com) — search APIs, list package contents, and inspect full specifications (OData EDMX, REST OpenAPI, SOAP WSDL) directly from Claude.

---

> ## Disclaimer
>
> **This project is an independent, community-developed tool and is not affiliated with, endorsed by, sponsored by, or in any way officially connected to SAP SE or any of its subsidiaries or affiliates.**
>
> The names "SAP", "SAP Business Accelerator Hub", and related product and service names are trademarks or registered trademarks of SAP SE. All rights in such trademarks are reserved by SAP SE. This project uses publicly available APIs provided by SAP Business Accelerator Hub solely to facilitate programmatic access for end users who already have authorised accounts.
>
> This software is provided **"as is"**, without warranty of any kind, express or implied. The author(s) accept no liability for any damages, data loss, account suspension, terms-of-service violations, or any other consequence arising from the use of this software. **Use at your own risk.**
>
> Users are solely responsible for ensuring their use of this tool complies with the [SAP Business Accelerator Hub Terms of Use](https://api.sap.com/terms-of-use) and any other applicable SAP terms, licences, and agreements.

---

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

| Parameter | Type | Description |
|---|---|---|
| `force` | boolean | Force a fresh login even if an existing session is still valid. |

### `search_packages`
Search for product packages on SAP Business Accelerator Hub. Useful for finding the correct `packageName` to use in `list_apis` or `search_apis`. No login required.

| Parameter | Type | Description |
|---|---|---|
| `searchTerm` *(required)* | string | Keyword, e.g. `"S/4HANA"`, `"SuccessFactors"`. Use `"*"` to list all packages. |
| `top` | number | Max results (default 20, max 50). |

### `search_apis`
Keyword search across the entire catalog. Results are scoped to the specified package when `packageName` is provided. No login required.

| Parameter | Type | Description |
|---|---|---|
| `searchTerm` *(required)* | string | Keyword, e.g. `"sales order"`. Use `"*"` to list everything. |
| `packageName` | string | Restrict results to a specific package technical name, e.g. `"SAPS4HANACloud"`. |
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
| `filter` | string | Return only endpoints/entities/operations whose path, summary, or referenced schema name matches. e.g. `"/sfcdetail"`, `"SfcDetailResponse"`, `"start"`. |

Returns:
- **OData** → entity types, key fields, all properties with SAP labels and types
- **REST** → all endpoints, path/query parameters, fully resolved request/response schemas (OpenAPI 3.0 and Swagger 2.0)
- **SOAP** → operations, message parts and element types (WSDL)

> **Schema resolution**: all `$ref` references are resolved inline — including nested objects, arrays, and enums. Swagger 2.0 `in: body` parameters are resolved the same way as OpenAPI 3.0 `requestBody`.

> **Filtering by schema name**: `filter` matches against response and request schema names referenced by each endpoint (e.g. `filter: "SfcDetailResponse"` returns every endpoint that uses that schema), not just the path string.

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

Use `login` with `force: true` to refresh a session before it expires.

Cookies are stored **locally only** — never committed to git or sent anywhere.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| *"No Chromium-based browser found"* | Install [Chrome](https://google.com/chrome), [Edge](https://microsoft.com/edge), or [Brave](https://brave.com). |
| *"Login timed out after 2 minutes"* | Call `login` again and complete sign-in within 2 minutes of the browser opening. |
| *"API not found (404)"* | Use `search_apis` to find the correct technical name — display names won't work. |
| `get_spec` returns `login_required` | Call `login` first, then retry. |
| Session expired | Call `login` again (or `login` with `force: true`) to refresh the saved cookies. |
| `search_apis` with `packageName` returns 0 results | Verify the package technical name using `search_packages` first. |
| `get_spec` filter returns 0 results | Filters match paths, summaries, and schema names — check spelling and try a shorter substring. |

---

## License

MIT
