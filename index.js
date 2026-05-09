#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { createServer } from "net";
import { homedir, tmpdir } from "os";
import { join } from "path";
import AdmZip from "adm-zip";

// #region Constants
const CATALOG_BASE = "https://api.sap.com/odata/1.0/catalog.svc";
const SEARCH_BASE  = "https://api.sap.com/api/1.0/searchservice";
const SAP_HUB_URL  = "https://api.sap.com";
const SAP_LOGIN_URL = "https://api.sap.com/loginservice";
const COOKIE_PATH  = join(homedir(), ".sap-api-mcp", "cookies.json");

// API used to verify session validity (OData spec download requires login)
const SESSION_TEST_URL =
  `${CATALOG_BASE}/Artifacts(Name='API_BUSINESS_PARTNER',Type='API')/$value`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// #endregion

// #region Cookie storage
function loadCookies() {
  try {
    return JSON.parse(readFileSync(COOKIE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveCookies(cookieString) {
  mkdirSync(join(homedir(), ".sap-api-mcp"), { recursive: true });
  writeFileSync(
    COOKIE_PATH,
    JSON.stringify({ cookieString, savedAt: new Date().toISOString() }, null, 2)
  );
}

function getAuthHeaders() {
  const cookies = loadCookies();
  if (cookies?.cookieString) return { Cookie: cookies.cookieString };
  return {};
}

async function isSessionValid(cookieString) {
  // SAP returns HTTP 200 even for the JS-based login redirect page.
  // A real authenticated response has content-type application/zip (spec download),
  // never text/html.
  try {
    const r = await fetch(SESSION_TEST_URL, {
      headers: { Accept: "*/*", Cookie: cookieString },
      redirect: "follow",
    });
    const ct = r.headers.get("content-type") || "";
    return ct.includes("zip") || ct.includes("json") || ct.includes("xml") || ct.includes("octet-stream");
  } catch {
    return false;
  }
}

// #endregion

// #region Browser detection
function findChromiumBrowser() {
  const p = process.platform;

  const candidates =
    p === "darwin"
      ? [
          { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Chrome" },
          { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Edge" },
          { path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", name: "Brave" },
          { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "Chromium" },
        ]
      : p === "win32"
      ? [
          { path: (process.env.LOCALAPPDATA  || "") + "\\Google\\Chrome\\Application\\chrome.exe",   name: "Chrome" },
          { path: (process.env.PROGRAMFILES  || "") + "\\Google\\Chrome\\Application\\chrome.exe",   name: "Chrome" },
          { path: (process.env["PROGRAMFILES(X86)"] || "") + "\\Google\\Chrome\\Application\\chrome.exe", name: "Chrome" },
          { path: (process.env.LOCALAPPDATA  || "") + "\\Microsoft\\Edge\\Application\\msedge.exe",  name: "Edge" },
          { path: (process.env.PROGRAMFILES  || "") + "\\Microsoft\\Edge\\Application\\msedge.exe",  name: "Edge" },
        ]
      : [
          { path: "google-chrome",        name: "Chrome" },
          { path: "google-chrome-stable", name: "Chrome" },
          { path: "chromium-browser",     name: "Chromium" },
          { path: "chromium",             name: "Chromium" },
          { path: "microsoft-edge",       name: "Edge" },
          { path: "brave-browser",        name: "Brave" },
        ];

  for (const { path, name } of candidates.filter((c) => c.path)) {
    try {
      if (p === "linux") execSync(`which "${path}"`, { stdio: "ignore" });
      else statSync(path);
      return { path, name };
    } catch {}
  }
  return null;
}

// #endregion

// #region Free TCP port helper
function getFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// #endregion

// #region Login (CDP — fully automated)
async function doLogin({ force = false } = {}) {
  // Check if existing session is still valid
  if (!force) {
    const existing = loadCookies();
    if (existing?.cookieString) {
      if (await isSessionValid(existing.cookieString)) {
        return { status: "already_logged_in", message: "Already logged in. Session is still valid." };
      }
      // Session expired — continue to re-login
    }
  }

  // Find a Chromium-based browser
  const browser = findChromiumBrowser();
  if (!browser) {
    throw new Error(
      "No Chromium-based browser found on this system.\n" +
      "Please install one of the following and try again:\n" +
      "  • Chrome:  https://google.com/chrome\n" +
      "  • Edge:    https://microsoft.com/edge\n" +
      "  • Brave:   https://brave.com\n" +
      "  • Chromium: https://chromium.org/getting-involved/download-chromium"
    );
  }

  const debugPort = await getFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), "sap-mcp-"));

  const proc = spawn(
    browser.path,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--window-size=1100,800",
      SAP_LOGIN_URL,
    ],
    { stdio: "ignore" }
  );

  // Track whether the browser was closed by the user before login completed
  let browserExited = false;
  proc.on("exit", () => { browserExited = true; });
  proc.on("error", () => { browserExited = true; });

  const cleanup = () => {
    try { proc.kill(); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  try {
    // Wait for the browser's remote debugging port to become available
    let tabs = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(1000);
      if (browserExited) {
        throw new Error(`${browser.name} failed to start or exited unexpectedly. Please try again.`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json`);
        tabs = await res.json();
        if (tabs.length) break;
      } catch {}
    }
    if (!tabs?.length) {
      throw new Error(
        `${browser.name} started but the debugger port is unreachable. ` +
        "This can happen if another instance is already using that port. Please try again."
      );
    }

    // Connect to the browser via WebSocket (native in Node.js 22+)
    const tab = tabs.find((t) => t.type === "page") || tabs[0];
    const ws = new WebSocket(tab.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () =>
        reject(new Error(`Could not connect to ${browser.name} debugger. Please try again.`)),
        { once: true }
      );
      setTimeout(() => reject(new Error("Browser debugger connection timed out.")), 12_000);
    });

    // Minimal CDP client
    let msgId = 1;
    const cdp = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        const onMsg = ({ data }) => {
          const msg = JSON.parse(data);
          if (msg.id !== id) return;
          ws.removeEventListener("message", onMsg);
          msg.error ? reject(new Error(`CDP error (${method}): ${msg.error.message}`)) : resolve(msg.result);
        };
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          ws.removeEventListener("message", onMsg);
          reject(new Error(`CDP command timed out: ${method}`));
        }, 12_000);
      });

    // Poll every 3 seconds until the browser cookies grant access to the protected endpoint
    const TIMEOUT_MS = 120_000;
    const deadline   = Date.now() + TIMEOUT_MS;
    let cookieString = null;

    while (Date.now() < deadline) {
      await sleep(3000);

      if (browserExited) {
        throw new Error(
          `${browser.name} was closed before login completed. ` +
          "Please try again and keep the browser open until you see a success message."
        );
      }

      try {
        const { cookies } = await cdp("Network.getCookies", { urls: [SAP_HUB_URL] });
        if (!cookies.length) continue;

        const str = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        if (await isSessionValid(str)) {
          cookieString = str;
          break;
        }
      } catch {
        // Transient CDP / network error — keep polling
      }
    }

    ws.close();

    if (!cookieString) {
      throw new Error(
        "Login timed out after 2 minutes. " +
        "Please call login() again and complete the sign-in within 2 minutes of the browser opening."
      );
    }

    saveCookies(cookieString);
    return {
      status: "success",
      message:
        `Logged in successfully via ${browser.name}. ` +
        "Session saved — get_spec now works for all API types (OData, REST, SOAP). " +
        `Cookies stored at: ${COOKIE_PATH}`,
    };
  } finally {
    cleanup();
  }
}

// #endregion

// #region Fetch helpers
async function safeFetch(url, options = {}) {
  let resp;
  try {
    resp = await fetch(url, options);
  } catch (err) {
    throw new Error(
      `Network error reaching SAP API Hub: ${err.message}. ` +
      "Please check your internet connection."
    );
  }

  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html") || resp.status === 302) {
    throw new Error(
      "Authentication required. Run the `login` tool to log in to SAP Business Accelerator Hub."
    );
  }
  if (resp.status === 404) {
    throw new Error(
      `Resource not found (404). Verify the API or package name is correct. URL: ${url}`
    );
  }
  if (!resp.ok) {
    let body = "";
    try { body = await resp.text(); } catch {}
    throw new Error(`SAP API returned HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp;
}

async function fetchJson(url, options = {}) {
  const resp = await safeFetch(url, options);
  try {
    return await resp.json();
  } catch {
    throw new Error("SAP API returned invalid JSON. Please try again.");
  }
}

// #endregion

// #region Tool: search_apis
// #region Tool: search_packages
async function searchPackages({ searchTerm, top = 20 }) {
  top = Math.min(Math.max(1, top), 50);

  const params = new URLSearchParams({
    searchterm: searchTerm,
    $top: String(top),
    $skip: "0",
    $type: '["Package"]',
    $refinedBy: "true",
    NoAgg: "true",
  });

  const data = await fetchJson(`${SEARCH_BASE}?${params}`, {
    headers: { Accept: "application/json", ...getAuthHeaders() },
  });

  const hits = data.hits?.hits || [];
  if (!hits.length && data.hits?.total === 0) {
    return {
      total: 0,
      returned: 0,
      results: [],
      note: `No packages found matching "${searchTerm}".`,
    };
  }

  const results = hits.map((h) => {
    const s = h._source;
    return {
      displayName:   s.DisplayName,
      technicalName: s.Name,
      shortText:     s.ShortText,
      url: `https://api.sap.com/package/${s.Name}/overview`,
    };
  });

  return { total: data.hits?.total || 0, returned: results.length, results };
}

// #endregion

async function searchApis({ searchTerm, packageName, apiType, top = 20 }) {
  top = Math.min(Math.max(1, top), 50);

  const params = new URLSearchParams({
    searchterm: searchTerm,
    $top: String(top),
    $skip: "0",
    $type: '["API"]',
    $refinedBy: "true",
    NoAgg: "true",
  });
  if (packageName) params.set("$parentTechnicalName", packageName);
  if (apiType)     params.set("$filter", `(SubType:["${apiType.toUpperCase()}"])`);

  const data = await fetchJson(`${SEARCH_BASE}?${params}`, {
    headers: { Accept: "application/json", ...getAuthHeaders() },
  });

  const hits = data.hits?.hits || [];
  if (!hits.length && data.hits?.total === 0) {
    return {
      total: 0,
      returned: 0,
      results: [],
      note: packageName
        ? `No APIs found matching "${searchTerm}" in package "${packageName}". ` +
          "Verify the package name or broaden your search."
        : `No APIs found matching "${searchTerm}".`,
    };
  }

  let results = hits.map((h) => {
    const s = h._source;
    return {
      displayName:          s.DisplayName,
      technicalName:        s.Name,
      shortText:            s.ShortText,
      description:          s.Description || null,
      version:              s.Version,
      apiType:              s.SubType,
      status:               s.APIState,
      package:              s.ParentTechnicalName,
      packageDisplayName:   s.ParentDisplayName,
      communicationScenario: s.additionalAttributeMap?.CommunicationScenario?.trim() || null,
      businessObject:        s.additionalAttributeMap?.BusinessObject?.trim() || null,
      url: `https://api.sap.com/api/${s.Name}/overview`,
    };
  });

  // Client-side package filter as a safety net — the SAP search API does not reliably
  // scope results to $parentTechnicalName when a searchTerm is also provided.
  if (packageName) {
    results = results.filter(
      (r) => r.package?.toLowerCase() === packageName.toLowerCase()
    );
  }

  return { total: data.hits?.total || 0, returned: results.length, results };
}

// #endregion

// #region Tool: list_apis
async function listApis({ packageName, apiType, top = 50 }) {
  top = Math.min(Math.max(1, top), 100);

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
    displayName:   r.DisplayName,
    apiType:       r.SubType,
    status:        r.State,
    description:   r.Description,
    version:       r.Version,
    url: `https://api.sap.com/api/${r.Name}/overview`,
  }));

  if (!results.length) {
    return {
      package: packageName,
      total: 0,
      results: [],
      note: apiType
        ? `No ${apiType} APIs found in package "${packageName}".`
        : `No APIs found in package "${packageName}". ` +
          "Verify the package name using search_apis with a keyword search.",
    };
  }

  return { package: packageName, total: results.length, results };
}

// #endregion

// #region Tool: get_spec
async function getSpec({ apiName, filter }) {
  // Look up the API type first (no auth needed) so we can give better errors
  let apiType = null;
  try {
    const metaUrl =
      `${CATALOG_BASE}/Artifacts(Name='${encodeURIComponent(apiName)}',Type='API')` +
      `?$format=json&$select=Name,SubType`;
    const meta = await fetchJson(metaUrl, {
      headers: { Accept: "application/json", ...getAuthHeaders() },
    });
    apiType = meta.d?.SubType ?? null;
  } catch (err) {
    if (err.message.includes("404")) {
      throw new Error(
        `API "${apiName}" not found in the SAP catalog. ` +
        "Use search_apis to find the correct technical name."
      );
    }
  }

  // For REST / SOAP / GraphQL, login is required; warn early
  const needsLogin = apiType && !["ODATA", "ODATAV4"].includes(apiType);
  if (needsLogin && !loadCookies()?.cookieString) {
    return {
      api: apiName,
      apiType,
      error: "login_required",
      message:
        `"${apiName}" is a ${apiType} API. ` +
        "Run the `login` tool first to access the full specification.",
    };
  }

  // Download the spec (returns as application/zip)
  const specUrl =
    `${CATALOG_BASE}/Artifacts(Name='${encodeURIComponent(apiName)}',Type='API')/$value`;

  let buffer;
  try {
    const resp = await safeFetch(specUrl, {
      headers: { Accept: "*/*", ...getAuthHeaders() },
    });
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("zip") && !ct.includes("octet-stream") && !ct.includes("json") && !ct.includes("xml")) {
      throw new Error(
        `Unexpected content-type "${ct}". ` +
        "Run the `login` tool first if you haven't already."
      );
    }
    const arrayBuf = await resp.arrayBuffer();
    buffer = Buffer.from(arrayBuf);
  } catch (err) {
    if (err.message.includes("Authentication required") && !apiType) {
      throw new Error(
        `Spec for "${apiName}" requires login. Run the \`login\` tool first.`
      );
    }
    throw err;
  }

  // Extract the relevant file from the ZIP
  const { content, filename } = extractFromZip(buffer, apiName);
  return parseSpecContent(apiName, apiType, content, filename, filter);
}

// #endregion

// #region ZIP extraction
function extractFromZip(buffer, apiName) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    // Not a ZIP — treat the raw buffer as the spec directly
    return { content: buffer.toString("utf-8"), filename: apiName };
  }

  const entries = zip.getEntries();
  if (!entries.length) throw new Error("ZIP archive is empty.");

  // Priority: .json > .edmx > .wsdl > first entry
  const pick = (ext) => entries.find((e) => e.entryName.toLowerCase().endsWith(ext));
  const chosen = pick(".json") || pick(".edmx") || pick(".wsdl") || entries[0];

  return {
    content: chosen.getData().toString("utf-8"),
    filename: chosen.entryName,
    allFiles: entries.map((e) => e.entryName),
  };
}

function parseSpecContent(apiName, apiType, content, filename, filter) {
  const name = filename?.toLowerCase() || "";
  try {
    if (name.endsWith(".json") || content.trimStart().startsWith("{")) {
      return { ...parseOpenApi(apiName, content, filter), sourceFile: filename };
    }
    if (name.endsWith(".edmx") || content.includes("edmx:Edmx") || content.includes("<edmx:")) {
      return { ...parseEdmx(apiName, content, filter), sourceFile: filename };
    }
    if (name.endsWith(".wsdl") || content.includes("wsdl:definitions") || content.includes(":definitions")) {
      return { ...parseWsdl(apiName, content, filter), sourceFile: filename };
    }
  } catch (parseErr) {
    return {
      api: apiName,
      apiType,
      sourceFile: filename,
      warning: `Downloaded but could not fully parse: ${parseErr.message}`,
      rawPreview: content.slice(0, 1000),
    };
  }
  return { api: apiName, apiType, sourceFile: filename, format: "unknown", rawPreview: content.slice(0, 1000) };
}

// #endregion

// #region Spec parsers
function parseOpenApi(apiName, raw, filter) {
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON in OpenAPI spec.");
  }

  const paths = spec.paths || {};
  const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

  let endpoints = Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([m]) => HTTP_METHODS.has(m))
      .map(([method, op]) => {
        // Swagger 2.0 puts the body in parameters with in:"body"; OpenAPI 3.0 uses requestBody.
        const bodyParam = (op.parameters || []).find((p) => p.in === "body");

        // Collect raw $ref names (before resolution) so filter can match schema names.
        const schemaRefs = new Set();
        const collectRefs = (schema) => {
          if (!schema) return;
          if (schema.$ref) schemaRefs.add(schema.$ref.split("/").pop().toLowerCase());
          if (schema.properties) Object.values(schema.properties).forEach(collectRefs);
          if (schema.items) collectRefs(schema.items);
          (schema.allOf || schema.anyOf || schema.oneOf || []).forEach(collectRefs);
        };
        Object.values(op.responses || {}).forEach((r) =>
          collectRefs(r.content?.["application/json"]?.schema || r.schema)
        );
        if (op.requestBody) collectRefs(op.requestBody.content?.["application/json"]?.schema);
        if (bodyParam?.schema) collectRefs(bodyParam.schema);

        return {
          method: method.toUpperCase(),
          path,
          summary: op.summary || op.operationId || null,
          _schemaRefs: [...schemaRefs],
          parameters: (op.parameters || [])
            .filter((p) => p.in !== "body")
            .map((p) => ({
              name:        p.name,
              in:          p.in,
              required:    p.required || false,
              type:        p.schema?.type || p.type || null,
              enum:        p.schema?.enum || p.enum || null,
              description: p.description || null,
            })),
          requestBody:
            op.requestBody
              ? summarizeSchema(op.requestBody.content?.["application/json"]?.schema, spec)
              : bodyParam?.schema
              ? summarizeSchema(bodyParam.schema, spec)
              : null,
          responses: Object.entries(op.responses || {}).map(([code, r]) => ({
            status:      code,
            description: r.description || null,
            schema:      summarizeSchema(
              r.content?.["application/json"]?.schema || r.schema || null,
              spec
            ),
          })),
        };
      })
  );

  if (filter) {
    const f = filter.toLowerCase();
    endpoints = endpoints.filter(
      (e) =>
        e.path.toLowerCase().includes(f) ||
        (e.summary && e.summary.toLowerCase().includes(f)) ||
        e._schemaRefs.some((r) => r.includes(f))
    );
  }

  // Strip internal helper field before returning
  endpoints.forEach((e) => delete e._schemaRefs);

  return {
    api:           apiName,
    format:        "OpenAPI",
    specVersion:   spec.openapi || spec.swagger || "unknown",
    title:         spec.info?.title        || null,
    description:   spec.info?.description  || null,
    endpointCount: endpoints.length,
    endpoints,
    filterApplied: filter || null,
  };
}

function parseEdmx(apiName, xml, filter) {
  let entityTypes = [];
  const etRegex = /<EntityType[^>]+Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  let m;

  while ((m = etRegex.exec(xml)) !== null) {
    const name = m[1];
    const body = m[2];

    const keyFields = [...body.matchAll(/<PropertyRef\s+Name="([^"]+)"/g)].map((k) => k[1]);

    const properties = [...body.matchAll(/<Property\s([^/]*?)\/>/g)].map((p) => {
      const a   = p[1];
      const get = (n) => a.match(new RegExp(`${n}="([^"]*)"`)) ?.[1] ?? null;
      return {
        name:      get("Name"),
        type:      get("Type"),
        nullable:  get("Nullable") !== "false",
        maxLength: get("MaxLength") ? Number(get("MaxLength")) : undefined,
        label:     get("sap:label")  || undefined,
      };
    });

    entityTypes.push({ entityType: name, keyFields, properties });
  }

  if (filter) {
    const f = filter.toLowerCase();
    entityTypes = entityTypes.filter((et) => et.entityType.toLowerCase().includes(f));
  }

  if (!entityTypes.length) {
    throw new Error(
      filter
        ? `No EntityTypes matching "${filter}" found in the EDMX document.`
        : "Could not parse any EntityTypes from the EDMX document."
    );
  }

  return {
    api: apiName,
    format: "OData EDMX",
    entityTypeCount: entityTypes.length,
    entityTypes,
    filterApplied: filter || null,
  };
}

function parseWsdl(apiName, xml, filter) {
  let operations = [
    ...xml.matchAll(/<(?:wsdl:)?operation\s+name="([^"]+)"/g),
  ].map((m) => m[1]);

  const messages = [
    ...xml.matchAll(
      /<(?:wsdl:)?message\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:wsdl:)?message>/g
    ),
  ].map((m) => ({
    message: m[1],
    parts: [...m[2].matchAll(
      /<(?:wsdl:)?part\s+name="([^"]+)"\s+(?:element|type)="([^"]+)"/g
    )].map((p) => ({ name: p[1], type: p[2] })),
  }));

  if (filter) {
    const f = filter.toLowerCase();
    operations = operations.filter((op) => op.toLowerCase().includes(f));
  }

  if (!operations.length) {
    throw new Error(
      filter
        ? `No operations matching "${filter}" found in the WSDL document.`
        : "Could not parse any operations from the WSDL document."
    );
  }

  return {
    api: apiName,
    format: "SOAP WSDL",
    operationCount: operations.length,
    operations,
    messages,
    filterApplied: filter || null,
  };
}

function summarizeSchema(schema, spec, seen = new Set()) {
  if (!schema) return null;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { $ref: schema.$ref, note: "Circular reference" };
    const newSeen = new Set(seen);
    newSeen.add(schema.$ref);
    const resolved = resolveRef(schema.$ref, spec);
    return summarizeSchema(resolved, spec, newSeen);
  }

  const result = {
    type: schema.type || null,
    description: schema.description || null,
    enum: schema.enum || null,
  };

  if (schema.type === "array") {
    result.items = summarizeSchema(schema.items, spec, seen);
  } else if (schema.type === "object" || schema.properties) {
    result.type = "object";
    result.properties = Object.fromEntries(
      Object.entries(schema.properties || {}).map(([k, v]) => [
        k,
        summarizeSchema(v, spec, seen),
      ])
    );
  }
  return result;
}

function resolveRef(ref, spec) {
  if (!ref || typeof ref !== "string" || !ref.startsWith("#/")) {
    return { note: `External or invalid ref ${ref} not supported` };
  }
  const parts = ref.split("/").slice(1);
  let current = spec;
  for (const part of parts) {
    current = current?.[part];
  }
  return current || { note: `Could not resolve ref ${ref}` };
}

// #endregion

// #region MCP Server
const server = new Server(
  { name: "sap-api-mcp", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "login",
      description:
        "Log in to SAP Business Accelerator Hub. Automatically opens a browser window " +
        "(Chrome, Edge, or Brave — detected on Mac, Linux, and Windows). " +
        "Log in normally; the session is captured automatically once detected. " +
        "The browser closes by itself when done. " +
        "Required for get_spec on REST, SOAP, and GraphQL APIs. " +
        "Session is saved at ~/.sap-api-mcp/cookies.json and reused until it expires.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Force a fresh login even if an existing session is still valid.",
          },
        },
      },
    },
    {
      name: "search_packages",
      description:
        "Search for product packages on SAP Business Accelerator Hub (api.sap.com). " +
        "Returns matching packages with technical names, display names and descriptions. " +
        "Useful for finding the correct packageName to use in list_apis or search_apis.",
      inputSchema: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description:
              'Keyword to search for, e.g. "S/4HANA", "SuccessFactors", "Ariba". ' +
              'Use "*" to list all packages.',
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
      name: "search_apis",
      description:
        "Search for APIs on SAP Business Accelerator Hub (api.sap.com). " +
        "Returns matching APIs with technical names, types, packages, " +
        "communication scenarios and business objects. No login required.",
      inputSchema: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description:
              'Keyword to search for, e.g. "sales order", "business partner", "material". ' +
              'Use "*" to list all APIs.',
          },
          packageName: {
            type: "string",
            description:
              'Filter by product package technical name, e.g. "SAPS4HANACloud", ' +
              '"SAPSuccessFactors". Use list_apis to browse a specific package.',
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
        "List all APIs in a specific SAP product package. " +
        'Use the package technicalName from search results, e.g. "SAPS4HANACloud". ' +
        "No login required.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: {
            type: "string",
            description:
              'Package technical name, e.g. "SAPS4HANACloud", "SAPSuccessFactors", ' +
              '"SAPExtendedWarehouseManagement".',
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
        "Download and parse the full specification for any SAP API:\n" +
        "• OData V2/V4 — entity types, key fields, all properties with types and labels\n" +
        "• REST        — all endpoints, path/query parameters, request/response schemas\n" +
        "• SOAP        — operations, message parts and element types\n" +
        "OData APIs work with SAP_API_KEY env var or after login. " +
        "REST, SOAP, and GraphQL require login.",
      inputSchema: {
        type: "object",
        properties: {
          apiName: {
            type: "string",
            description:
              'Technical API name, e.g. "API_BUSINESS_PARTNER", "CE_SALES_ORDERS_0001". ' +
              "Use search_apis or list_apis to find the correct name.",
          },
          filter: {
            type: "string",
            description:
              'Optional filter to return only specific endpoints, entities, or operations. ' +
              'e.g. "/sfcdetail", "SfcDetailResponse", "start". Helpful for large APIs.',
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
      case "login":           result = await doLogin(args);         break;
      case "search_packages": result = await searchPackages(args);  break;
      case "search_apis":     result = await searchApis(args);      break;
      case "list_apis":       result = await listApis(args);        break;
      case "get_spec":        result = await getSpec(args);         break;
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
console.error("sap-api-mcp v3 running on stdio");
// #endregion
