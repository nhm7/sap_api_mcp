#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CATALOG_BASE = "https://api.sap.com/odata/1.0/catalog.svc";
const SEARCH_BASE = "https://api.sap.com/api/1.0/searchservice";
const SAP_HUB_URL = "https://api.sap.com";
const COOKIE_PATH = join(homedir(), ".sap-api-mcp", "cookies.json");
const API_KEY = process.env.SAP_API_KEY || "";

// ---------------------------------------------------------------------------
// Cookie storage
// ---------------------------------------------------------------------------
function loadCookies() {
  try {
    return JSON.parse(readFileSync(COOKIE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveCookies(cookieString) {
  const dir = join(homedir(), ".sap-api-mcp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(COOKIE_PATH, JSON.stringify({ cookieString, savedAt: new Date().toISOString() }, null, 2));
}

function getAuthHeaders() {
  const cookies = loadCookies();
  const headers = {};
  if (cookies?.cookieString) headers["Cookie"] = cookies.cookieString;
  else if (API_KEY) headers["APIKey"] = API_KEY;
  return headers;
}

function isLoggedIn() {
  return existsSync(COOKIE_PATH) && !!loadCookies()?.cookieString;
}

// ---------------------------------------------------------------------------
// Cross-platform browser open
// ---------------------------------------------------------------------------
function openBrowser(url) {
  try {
    if (process.platform === "darwin") execSync(`open "${url}"`);
    else if (process.platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    // Silently ignore — URL is shown to user anyway
  }
}

// ---------------------------------------------------------------------------
// Login: 2-step browser cookie flow
// ---------------------------------------------------------------------------
async function doLogin({ cookies } = {}) {
  // Step 2: cookies provided — save them and verify
  if (cookies) {
    saveCookies(cookies.trim());

    // Quick verification: try a protected endpoint
    const testUrl =
      `${CATALOG_BASE}/Artifacts(Name='API_BUSINESS_PARTNER',Type='API')/$value`;
    try {
      const resp = await fetch(testUrl, {
        headers: { Accept: "*/*", Cookie: cookies.trim() },
        redirect: "manual",
      });
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("text/html") || resp.status === 302) {
        // Cookies didn't work — delete and inform
        writeFileSync(COOKIE_PATH, JSON.stringify({ cookieString: null }));
        return {
          status: "invalid",
          message:
            "The provided cookies don't grant access to SAP API Hub. " +
            "Make sure you are logged in on api.sap.com before copying cookies, " +
            "and that you copied all cookies for the api.sap.com domain.",
        };
      }
    } catch {
      // Network error during verification — save anyway, will fail later if wrong
    }

    return {
      status: "success",
      message:
        "Cookies saved successfully. You can now use get_spec for all API types (OData, REST, SOAP). " +
        `Saved at: ${COOKIE_PATH}`,
    };
  }

  // Step 1: Open browser and return instructions
  openBrowser(SAP_HUB_URL);

  return {
    status: "instructions",
    message: "Browser opened to api.sap.com. Follow these steps to complete login:",
    steps: [
      "1. Log in with your SAP account in the browser that just opened.",
      "2. After logging in, open DevTools: press F12 (or Cmd+Option+I on Mac).",
      "3. Go to the 'Application' tab (Chrome) or 'Storage' tab (Firefox).",
      "4. Click 'Cookies' → 'https://api.sap.com' in the left panel.",
      "5. Click on any cookie row, then press Ctrl+A to select all cookies.",
      "   Alternatively: go to the 'Network' tab, reload the page, click any request to api.sap.com,",
      "   find the 'Cookie' header under Request Headers, and copy its full value.",
      "6. Call login again with the cookies parameter: login({ cookies: '<paste here>' })",
    ],
    tip: "The cookie string looks like: 'name1=value1; name2=value2; ...'",
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function safeFetch(url, options = {}) {
  const resp = await fetch(url, options);
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html") || resp.status === 302) {
    throw new Error(
      "SAP returned a login page. Run the `login` tool first, follow the steps, " +
      "then call `login` again with your browser cookies to authenticate."
    );
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp;
}

async function fetchJson(url, options = {}) {
  const resp = await safeFetch(url, options);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Tool: search_apis
// ---------------------------------------------------------------------------
async function searchApis({ searchTerm, packageName, apiType, top = 20 }) {
  top = Math.min(top, 50);
  const params = new URLSearchParams({
    searchterm: searchTerm,
    $top: String(top),
    $skip: "0",
    $type: '["API"]',
    $refinedBy: "true",
    NoAgg: "true",
  });
  if (packageName) params.set("$parentTechnicalName", packageName);
  if (apiType) params.set("$filter", `(SubType:["${apiType.toUpperCase()}"])`);

  const data = await fetchJson(`${SEARCH_BASE}?${params}`, {
    headers: { Accept: "application/json", ...getAuthHeaders() },
  });

  const results = (data.hits?.hits || []).map((h) => {
    const s = h._source;
    return {
      displayName: s.DisplayName,
      technicalName: s.Name,
      shortText: s.ShortText,
      version: s.Version,
      apiType: s.SubType,
      status: s.APIState,
      package: s.ParentTechnicalName,
      packageDisplayName: s.ParentDisplayName,
      communicationScenario: s.additionalAttributeMap?.CommunicationScenario?.trim() || null,
      businessObject: s.additionalAttributeMap?.BusinessObject?.trim() || null,
      url: `https://api.sap.com/api/${s.Name}/overview`,
    };
  });

  return { total: data.hits?.total || 0, returned: results.length, results };
}

// ---------------------------------------------------------------------------
// Tool: list_apis
// ---------------------------------------------------------------------------
async function listApis({ packageName, apiType, top = 50 }) {
  top = Math.min(top, 100);
  let url =
    `${CATALOG_BASE}/ContentEntities.ContentPackages('${encodeURIComponent(packageName)}')/Artifacts` +
    `?$format=json&$top=${top}&$skip=0` +
    `&$select=Name,DisplayName,SubType,State,Description,Version`;
  if (apiType) {
    url += `&$filter=SubType%20eq%20'${encodeURIComponent(apiType.toUpperCase())}'`;
  }

  const data = await fetchJson(url, {
    headers: { Accept: "application/json", ...getAuthHeaders() },
  });

  const results = (data.d?.results || []).map((r) => ({
    technicalName: r.Name,
    displayName: r.DisplayName,
    apiType: r.SubType,
    status: r.State,
    description: r.Description,
    version: r.Version,
    url: `https://api.sap.com/api/${r.Name}/overview`,
  }));

  return { package: packageName, total: results.length, results };
}

// ---------------------------------------------------------------------------
// Tool: get_spec
// ---------------------------------------------------------------------------
async function getSpec({ apiName }) {
  // Download the raw spec from the catalog ($value)
  const specUrl =
    `${CATALOG_BASE}/Artifacts(Name='${encodeURIComponent(apiName)}',Type='API')/$value`;

  const resp = await safeFetch(specUrl, {
    headers: { Accept: "*/*", ...getAuthHeaders() },
  });

  const ct = resp.headers.get("content-type") || "";
  const raw = await resp.text();

  // JSON → OpenAPI (REST or OData published as Swagger)
  if (ct.includes("json") || raw.trimStart().startsWith("{")) {
    return parseOpenApi(apiName, raw);
  }

  // XML → either OData EDMX or SOAP WSDL
  if (ct.includes("xml") || raw.trimStart().startsWith("<")) {
    if (raw.includes("edmx:Edmx") || raw.includes("Edmx")) {
      return parseEdmx(apiName, raw);
    }
    if (raw.includes("wsdl:definitions") || raw.includes("definitions")) {
      return parseWsdl(apiName, raw);
    }
  }

  // Fallback: return raw (truncated)
  return { api: apiName, format: "unknown", raw: raw.slice(0, 2000) };
}

// ---------------------------------------------------------------------------
// Spec parsers
// ---------------------------------------------------------------------------
function parseOpenApi(apiName, raw) {
  const spec = JSON.parse(raw);
  const version = spec.openapi || spec.swagger || "unknown";
  const paths = spec.paths || {};

  const endpoints = Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([m]) => ["get", "post", "put", "patch", "delete"].includes(m))
      .map(([method, op]) => ({
        method: method.toUpperCase(),
        path,
        summary: op.summary || op.description || null,
        parameters: (op.parameters || []).map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required || false,
          type: p.schema?.type || p.type || null,
          description: p.description || null,
        })),
        requestBody: op.requestBody
          ? summarizeSchema(op.requestBody.content?.["application/json"]?.schema)
          : null,
        responses: Object.entries(op.responses || {}).map(([code, r]) => ({
          status: code,
          description: r.description || null,
          schema: summarizeSchema(r.content?.["application/json"]?.schema || r.schema),
        })),
      }))
  );

  return {
    api: apiName,
    format: "OpenAPI",
    specVersion: version,
    title: spec.info?.title,
    description: spec.info?.description,
    endpointCount: endpoints.length,
    endpoints,
  };
}

function parseEdmx(apiName, xml) {
  const entityTypes = [];
  const etRegex = /<EntityType[^>]+Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  let m;
  while ((m = etRegex.exec(xml)) !== null) {
    const name = m[1];
    const body = m[2];

    const keyFields = [...body.matchAll(/<PropertyRef\s+Name="([^"]+)"/g)].map((k) => k[1]);

    const properties = [...body.matchAll(/<Property\s([^/]*?)\/>/g)].map((p) => {
      const a = p[1];
      const attr = (n) => a.match(new RegExp(`${n}="([^"]*)"`)) ?.[1] ?? null;
      return {
        name: attr("Name"),
        type: attr("Type"),
        nullable: attr("Nullable") !== "false",
        maxLength: attr("MaxLength") ? Number(attr("MaxLength")) : undefined,
        label: attr("sap:label") || undefined,
      };
    });

    entityTypes.push({ entityType: name, keyFields, properties });
  }

  return { api: apiName, format: "OData EDMX", entityTypeCount: entityTypes.length, entityTypes };
}

function parseWsdl(apiName, xml) {
  const operations = [...xml.matchAll(/<(?:wsdl:)?operation\s+name="([^"]+)"/g)].map(
    (m) => m[1]
  );

  const messages = [...xml.matchAll(/<(?:wsdl:)?message\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:wsdl:)?message>/g)].map(
    (m) => {
      const parts = [...m[2].matchAll(/<(?:wsdl:)?part\s+name="([^"]+)"\s+(?:element|type)="([^"]+)"/g)].map(
        (p) => ({ name: p[1], type: p[2] })
      );
      return { message: m[1], parts };
    }
  );

  return { api: apiName, format: "SOAP WSDL", operationCount: operations.length, operations, messages };
}

function summarizeSchema(schema) {
  if (!schema) return null;
  if (schema.$ref) return { $ref: schema.$ref };
  if (schema.type === "array") return { type: "array", items: summarizeSchema(schema.items) };
  if (schema.type === "object" || schema.properties) {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(schema.properties || {}).map(([k, v]) => [
          k,
          { type: v.type || v.$ref || null, description: v.description || null },
        ])
      ),
    };
  }
  return { type: schema.type || null };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "sap-api-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "login",
      description:
        "Log in to SAP Business Accelerator Hub. Two-step process:\n" +
        "Step 1 — call with no arguments: opens api.sap.com in your browser and returns instructions.\n" +
        "Step 2 — call with `cookies` after logging in: paste the Cookie header value from browser DevTools.\n" +
        "Required for get_spec on REST and SOAP APIs. Cookies are saved locally at ~/.sap-api-mcp/cookies.json.",
      inputSchema: {
        type: "object",
        properties: {
          cookies: {
            type: "string",
            description:
              "The full Cookie header string copied from browser DevTools after logging in to api.sap.com. " +
              "Looks like: 'name1=value1; name2=value2; ...'",
          },
        },
      },
    },
    {
      name: "search_apis",
      description:
        "Search for APIs on SAP Business Accelerator Hub. Returns matching APIs with technical names, " +
        "types, packages, communication scenarios and business objects. No login required.",
      inputSchema: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description: 'Keyword to search for, e.g. "sales order", "business partner", "material".',
          },
          packageName: {
            type: "string",
            description: 'Filter by product package technical name, e.g. "SAPS4HANACloud".',
          },
          apiType: {
            type: "string",
            enum: ["SOAP", "ODATA", "ODATAV4", "REST", "GRAPHQL"],
            description: "Filter by API protocol type.",
          },
          top: {
            type: "number",
            description: "Maximum number of results (default 20, max 50).",
          },
        },
        required: ["searchTerm"],
      },
    },
    {
      name: "list_apis",
      description:
        "List all APIs in a specific SAP product package. Use the technicalName from search results " +
        "or known package names like \"SAPS4HANACloud\". No login required.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: {
            type: "string",
            description: 'Package technical name, e.g. "SAPS4HANACloud", "SAPSuccessFactors".',
          },
          apiType: {
            type: "string",
            enum: ["SOAP", "ODATA", "ODATAV4", "REST", "GRAPHQL"],
            description: "Filter by API type.",
          },
          top: {
            type: "number",
            description: "Maximum number of results (default 50, max 100).",
          },
        },
        required: ["packageName"],
      },
    },
    {
      name: "get_spec",
      description:
        "Download and parse the full specification for any SAP API. " +
        "Returns structured schema with all fields, types and operations:\n" +
        "- OData (V2/V4): entity types, key fields, all properties with types\n" +
        "- REST: all endpoints, parameters, request/response schemas\n" +
        "- SOAP: operations, message parts and types\n" +
        "Requires login for REST and SOAP. OData may work with SAP_API_KEY env var.",
      inputSchema: {
        type: "object",
        properties: {
          apiName: {
            type: "string",
            description: 'Technical API name, e.g. "API_BUSINESS_PARTNER", "CE_SALES_ORDERS_0001".',
          },
        },
        required: ["apiName"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "login":        result = await doLogin(args || {}); break;
      case "search_apis":  result = await searchApis(args); break;
      case "list_apis":    result = await listApis(args); break;
      case "get_spec":     result = await getSpec(args); break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("sap-api-mcp v2 running on stdio");
