#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomBytes } from "crypto";
import { createServer } from "http";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CLIENT_ID = "sb-hubXsuaa-public!b630346";
const AUTH_BASE = "https://sappubliccatalog.authentication.eu10.hana.ondemand.com";
const CATALOG_BASE = "https://api.sap.com/odata/1.0/catalog.svc";
const SEARCH_BASE = "https://api.sap.com/api/1.0/searchservice";
const SANDBOX_BASE = "https://sandbox.api.sap.com";
const TOKEN_PATH = join(homedir(), ".sap-api-mcp", "token.json");
const API_KEY = process.env.SAP_API_KEY || "";

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------
function loadToken() {
  try {
    const raw = readFileSync(TOKEN_PATH, "utf-8");
    const token = JSON.parse(raw);
    if (token.expires_at && Date.now() < token.expires_at - 60_000) return token;
    return null;
  } catch {
    return null;
  }
}

function saveToken(token) {
  const dir = join(homedir(), ".sap-api-mcp");
  mkdirSync(dir, { recursive: true });
  const expires_at = token.expires_in
    ? Date.now() + token.expires_in * 1000
    : Date.now() + 3600_000;
  writeFileSync(TOKEN_PATH, JSON.stringify({ ...token, expires_at }, null, 2));
}

function getAuthHeader() {
  const token = loadToken();
  if (token?.access_token) return { Authorization: `Bearer ${token.access_token}` };
  if (API_KEY) return { APIKey: API_KEY };
  return {};
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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
// OAuth PKCE login
// ---------------------------------------------------------------------------
async function doLogin() {
  const existing = loadToken();
  if (existing) {
    return { status: "already_logged_in", message: "Already logged in. Token is still valid." };
  }

  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(8).toString("hex");

  // Start local callback server on a random port
  const { server, port } = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authUrl =
    `${AUTH_BASE}/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&state=${state}`;

  openBrowser(authUrl);

  // Wait for the OAuth callback (90 second timeout)
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 90 seconds. Please try again."));
    }, 90_000);

    server.on("request", (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      if (error || returnedState !== state) {
        res.end(
          `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
            <h2>&#10060; Login failed</h2>
            <p>${error || "State mismatch"}</p>
            <p>You can close this tab.</p>
          </body></html>`
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error || "state mismatch"}`));
        return;
      }

      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>&#10003; Logged in successfully</h2>
          <p>You can close this tab and return to your AI assistant.</p>
        </body></html>`
      );
      clearTimeout(timeout);
      server.close();
      resolve(code);
    });
  });

  // Exchange code for token
  const tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const token = await tokenRes.json();
  saveToken(token);

  return {
    status: "success",
    message: "Logged in successfully. Token saved — you won't need to log in again until it expires.",
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function safeFetch(url, options = {}) {
  const resp = await fetch(url, options);
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    throw new Error(
      "SAP returned a login page. Run the `login` tool first to authenticate."
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
    headers: { Accept: "application/json", ...getAuthHeader() },
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
    headers: { Accept: "application/json", ...getAuthHeader() },
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
    headers: { Accept: "*/*", ...getAuthHeader() },
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
        "Log in to SAP Business Accelerator Hub via OAuth. Opens the SAP login page in your " +
        "browser automatically and captures the token. Required for downloading API specs (REST, SOAP). " +
        "Token is saved locally and reused across sessions.",
      inputSchema: { type: "object", properties: {} },
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
      case "login":        result = await doLogin(); break;
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
