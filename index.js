#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

const CATALOG_BASE = "https://api.sap.com/odata/1.0/catalog.svc";
const SEARCH_BASE = "https://api.sap.com/api/1.0/searchservice";
const SANDBOX_BASE = "https://sandbox.api.sap.com";

// API key is optional — only needed for OData $metadata via sandbox
const API_KEY = process.env.SAP_API_KEY || "";

function catalogHeaders() {
  const h = { Accept: "application/json", "User-Agent": "sap-api-mcp/1.0" };
  if (API_KEY) h["APIKey"] = API_KEY;
  return h;
}

function sandboxHeaders() {
  const h = { Accept: "application/xml", "User-Agent": "sap-api-mcp/1.0" };
  if (API_KEY) h["APIKey"] = API_KEY;
  return h;
}

// ---------------------------------------------------------------------------
// Helper: assert response is JSON (not an HTML redirect)
// ---------------------------------------------------------------------------
async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error(
      `Endpoint returned an HTML page instead of JSON. ` +
        `This endpoint may require OAuth browser login which is not supported. URL: ${url}`
    );
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function searchApis({ searchTerm, packageName, apiType, top = 20, skip = 0 }) {
  top = Math.min(top, 50);
  const params = new URLSearchParams({
    searchterm: searchTerm,
    $artifacts: "true",
    $top: String(top),
    $skip: String(skip),
    $type: '["API"]',
    $refinedBy: "true",
    NoAgg: "true",
  });
  if (packageName) params.set("$parentTechnicalName", packageName);
  if (apiType) params.set("$filter", `(SubType:["${apiType.toUpperCase()}"])`);

  const data = await fetchJson(`${SEARCH_BASE}?${params}`, {
    headers: catalogHeaders(),
  });

  const results = (data.hits?.hits || []).map((h) => {
    const s = h._source;
    return {
      displayName: s.DisplayName,
      technicalName: s.Name,
      shortText: s.ShortText,
      description: s.Description,
      version: s.Version,
      apiType: s.SubType,
      status: s.APIState,
      package: s.ParentTechnicalName,
      packageDisplayName: s.ParentDisplayName,
      communicationScenario: s.additionalAttributeMap?.CommunicationScenario?.trim() || null,
      businessObject: s.additionalAttributeMap?.BusinessObject?.trim() || null,
      scopeItems: s.additionalAttributeMap?.ScopeItems?.trim() || null,
      url: `https://api.sap.com/api/${s.Name}/overview`,
    };
  });

  return { total: data.hits?.total || 0, returned: results.length, results };
}

async function listPackages({ searchTerm, top = 20 }) {
  top = Math.min(top, 50);

  if (searchTerm) {
    const params = new URLSearchParams({
      searchterm: searchTerm,
      $top: String(top),
      $skip: "0",
      $type: '["API Package"]',
      $refinedBy: "true",
      NoAgg: "true",
    });
    const data = await fetchJson(`${SEARCH_BASE}?${params}`, {
      headers: catalogHeaders(),
    });
    const results = (data.hits?.hits || []).map((h) => ({
      technicalName: h._source.Name,
      displayName: h._source.DisplayName,
      shortText: h._source.ShortText || h._source.Description,
      vendor: h._source.Vendor,
      url: `https://api.sap.com/package/${h._source.Name}/overview`,
    }));
    return { total: data.hits?.total || 0, returned: results.length, results };
  }

  // Browse without search term via OData
  const url =
    `${CATALOG_BASE}/ContentEntities.ContentPackages` +
    `?$format=json&$top=${top}&$orderby=ModifiedAt%20desc` +
    `&$select=TechnicalName,DisplayName,ShortText,Vendor,Products`;
  const data = await fetchJson(url, { headers: catalogHeaders() });
  const results = (data.d?.results || []).map((r) => ({
    technicalName: r.TechnicalName,
    displayName: r.DisplayName,
    shortText: r.ShortText,
    vendor: r.Vendor,
    products: r.Products,
    url: `https://api.sap.com/package/${r.TechnicalName}/overview`,
  }));
  return { total: results.length, results };
}

async function listPackageApis({ packageName, apiType, top = 50, skip = 0 }) {
  top = Math.min(top, 100);
  let url =
    `${CATALOG_BASE}/ContentEntities.ContentPackages('${encodeURIComponent(packageName)}')/Artifacts` +
    `?$format=json&$top=${top}&$skip=${skip}` +
    `&$select=Name,DisplayName,SubType,State,Description,Version`;
  if (apiType) {
    url += `&$filter=SubType%20eq%20'${encodeURIComponent(apiType.toUpperCase())}'`;
  }

  const data = await fetchJson(url, { headers: catalogHeaders() });
  const results = (data.d?.results || []).map((r) => ({
    technicalName: r.Name,
    displayName: r.DisplayName,
    apiType: r.SubType,
    status: r.State,
    description: r.Description,
    version: r.Version,
    url: `https://api.sap.com/api/${r.Name}/overview`,
  }));
  return { total: results.length, results };
}

async function getApiDetail({ apiName }) {
  // Get artifact metadata directly (no packageName required)
  const url =
    `${CATALOG_BASE}/Artifacts(Name='${encodeURIComponent(apiName)}',Type='API')` +
    `?$format=json`;
  const data = await fetchJson(url, { headers: catalogHeaders() });
  const r = data.d;
  if (!r) throw new Error(`API '${apiName}' not found`);

  const toDate = (val) => {
    if (!val) return null;
    const ms = parseInt(val.match(/\d+/)?.[0] || "0");
    return new Date(ms).toISOString();
  };

  return {
    technicalName: r.Name,
    displayName: r.DisplayName,
    description: r.Description,
    apiType: r.SubType,
    version: r.Version,
    status: r.State,
    createdAt: toDate(r.CreatedAt),
    modifiedAt: toDate(r.ModifiedAt),
    url: `https://api.sap.com/api/${r.Name}/overview`,
    specUrl: `https://api.sap.com/odata/1.0/catalog.svc/Artifacts(Name='${r.Name}',Type='API')/$value`,
    note:
      r.SubType === "ODATA" || r.SubType === "ODATAV4"
        ? "Use get_api_spec to retrieve entity types and field definitions from the OData metadata."
        : "Spec download for this API type requires OAuth browser login on api.sap.com.",
  };
}

async function getApiSpec({ apiName, sandboxPath }) {
  if (!API_KEY) {
    throw new Error(
      "SAP_API_KEY environment variable is required to fetch API specs from the sandbox. " +
        "Set it to your API key from api.sap.com."
    );
  }

  // Fetch OData $metadata from sandbox and parse it into a readable schema
  const metaUrl = `${SANDBOX_BASE}${sandboxPath}/$metadata`;
  const resp = await fetch(metaUrl, { headers: sandboxHeaders() });
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error(
      `Sandbox endpoint returned HTML. Check that sandboxPath is correct and the API key is valid. ` +
        `sandboxPath should look like: /s4hanacloud/sap/opu/odata/sap/API_BUSINESS_PARTNER`
    );
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching $metadata`);
  }

  const xml = await resp.text();
  return parseODataMetadata(xml, apiName);
}

// ---------------------------------------------------------------------------
// OData $metadata XML parser — extracts entity types and their properties
// ---------------------------------------------------------------------------
function parseODataMetadata(xml, apiName) {
  const entityTypes = [];

  // Match all EntityType blocks
  const entityTypeRegex = /<EntityType[^>]+Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  let etMatch;
  while ((etMatch = entityTypeRegex.exec(xml)) !== null) {
    const typeName = etMatch[1];
    const body = etMatch[2];

    // Extract key fields
    const keyFields = [];
    const keyRegex = /<PropertyRef\s+Name="([^"]+)"/g;
    let km;
    while ((km = keyRegex.exec(body)) !== null) keyFields.push(km[1]);

    // Extract properties
    const properties = [];
    const propRegex = /<Property\s([^/]*?)\/>/g;
    let pm;
    while ((pm = propRegex.exec(body)) !== null) {
      const attrs = pm[1];
      const get = (attr) => {
        const m = attrs.match(new RegExp(`${attr}="([^"]*)"`));
        return m ? m[1] : null;
      };
      properties.push({
        name: get("Name"),
        type: get("Type"),
        nullable: get("Nullable") !== "false",
        maxLength: get("MaxLength") ? parseInt(get("MaxLength")) : undefined,
        label: get('sap:label') || get('Label') || undefined,
      });
    }

    // Extract navigation properties
    const navProps = [];
    const navRegex = /<NavigationProperty\s([^/]*?)\/>/g;
    let nm;
    while ((nm = navRegex.exec(body)) !== null) {
      const attrs = nm[1];
      const get = (attr) => {
        const m = attrs.match(new RegExp(`${attr}="([^"]*)"`));
        return m ? m[1] : null;
      };
      navProps.push({ name: get("Name"), toRole: get("ToRole") });
    }

    entityTypes.push({ entityType: typeName, keyFields, properties, navigationProperties: navProps });
  }

  return {
    api: apiName,
    entityTypeCount: entityTypes.length,
    entityTypes,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "sap-api-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_apis",
      description:
        "Search APIs on SAP Business Accelerator Hub (api.sap.com). " +
        "Returns matching APIs with their technical names, types, packages and descriptions. " +
        "No API key required.",
      inputSchema: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description: 'Search keyword, e.g. "product", "business partner", "warehouse". Use "*" to list all.',
          },
          packageName: {
            type: "string",
            description: 'Filter by package technical name, e.g. "SAPS4HANACloud".',
          },
          apiType: {
            type: "string",
            enum: ["SOAP", "ODATA", "ODATAV4", "REST", "GRAPHQL"],
            description: "Filter by API protocol type.",
          },
          top: { type: "number", description: "Max results (default 20, max 50)." },
          skip: { type: "number", description: "Pagination offset (default 0)." },
        },
        required: ["searchTerm"],
      },
    },
    {
      name: "list_packages",
      description:
        "List or search content packages (products) on SAP Business Accelerator Hub. " +
        "Packages group related APIs, e.g. SAP S/4HANA Cloud, SAP EWM. No API key required.",
      inputSchema: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description: 'Search keyword, e.g. "S/4HANA", "SuccessFactors". Omit to browse recent packages.',
          },
          top: { type: "number", description: "Max results (default 20, max 50)." },
        },
      },
    },
    {
      name: "list_package_apis",
      description:
        "List all APIs contained in a specific SAP package (product). " +
        "Use the technicalName from list_packages. No API key required.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: {
            type: "string",
            description: 'Package technical name, e.g. "SAPS4HANACloud".',
          },
          apiType: {
            type: "string",
            enum: ["SOAP", "ODATA", "ODATAV4", "REST", "GRAPHQL"],
            description: "Filter by API type.",
          },
          top: { type: "number", description: "Max results (default 50, max 100)." },
          skip: { type: "number", description: "Pagination offset (default 0)." },
        },
        required: ["packageName"],
      },
    },
    {
      name: "get_api_detail",
      description:
        "Get metadata for a specific API: description, type, version, status, URLs. " +
        "Use the technicalName from search_apis or list_package_apis. No API key required.",
      inputSchema: {
        type: "object",
        properties: {
          apiName: {
            type: "string",
            description: 'Technical API name, e.g. "API_BUSINESS_PARTNER".',
          },
        },
        required: ["apiName"],
      },
    },
    {
      name: "get_api_spec",
      description:
        "Fetch the OData $metadata for an API and return all entity types with their field names, " +
        "types, and key fields. This tells you the exact input/output parameters of an OData API. " +
        "Requires SAP_API_KEY environment variable and the sandboxPath for the API.",
      inputSchema: {
        type: "object",
        properties: {
          apiName: {
            type: "string",
            description: 'Technical API name for display, e.g. "API_BUSINESS_PARTNER".',
          },
          sandboxPath: {
            type: "string",
            description:
              'OData service path on sandbox.api.sap.com, e.g. ' +
              '"/s4hanacloud/sap/opu/odata/sap/API_BUSINESS_PARTNER". ' +
              'For S/4HANA Cloud APIs this is typically "/s4hanacloud/sap/opu/odata/sap/{TECHNICAL_NAME}".',
          },
        },
        required: ["apiName", "sandboxPath"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "search_apis":
        result = await searchApis(args);
        break;
      case "list_packages":
        result = await listPackages(args);
        break;
      case "list_package_apis":
        result = await listPackageApis(args);
        break;
      case "get_api_detail":
        result = await getApiDetail(args);
        break;
      case "get_api_spec":
        result = await getApiSpec(args);
        break;
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
console.error("sap-api-mcp running on stdio");
