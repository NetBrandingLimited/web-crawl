const fs = require("node:fs");
const path = require("node:path");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function extractStringArrayLiteral(source, arrayVarName) {
  // Grabs: const X = [ "a", "b", ... ] as const;
  const re = new RegExp(`const\\s+${arrayVarName}\\s*=\\s*\\[(.*?)\\]\\s*as const;`, "s");
  const m = source.match(re);
  if (!m) throw new Error(`Could not extract ${arrayVarName} array`);
  const inside = m[1];
  const items = [];
  const strRe = /"([^"]+)"/g;
  let mm;
  while ((mm = strRe.exec(inside))) items.push(mm[1]);
  return items;
}

function extractHeadersArray(source, arrayVarName) {
  // Similar extraction but supports: const headers = [ ... ] as const;
  return extractStringArrayLiteral(source, arrayVarName);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSameArray(a, b, label) {
  if (a.length !== b.length) {
    throw new Error(`${label}: length mismatch: ${a.length} vs ${b.length}`);
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`${label}: mismatch at index ${i}: "${a[i]}" vs "${b[i]}"`);
    }
  }
}

const root = path.join(__dirname, "..");

const clientPage = read(path.join(root, "src/app/crawl/page.tsx"));
const serverCompareRoute = read(path.join(root, "src/app/api/v1/crawl-jobs/compare/route.ts"));
const bulkRowsRoute = read(path.join(root, "src/app/api/v1/crawl-jobs/compare/rows/route.ts"));
const singleRowRoute = read(path.join(root, "src/app/api/v1/crawl-jobs/compare/row/route.ts"));

const clientHeaders = extractStringArrayLiteral(clientPage, "COMPARE_FULL_CSV_HEADERS");
const serverHeaders = extractHeadersArray(serverCompareRoute, "headers");

assertSameArray(clientHeaders, serverHeaders, "CSV header order");

// Ensure the returned row object includes keys for every header.
// We check for `key:` property names to exist in both endpoints.
function verifyEndpointKeys(routeSource, endpointLabel) {
  const missing = [];
  for (const key of clientHeaders) {
    const re = new RegExp(`\\b${escapeRegex(key)}\\s*:`, "g");
    if (!re.test(routeSource)) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`${endpointLabel}: missing property assignments for ${missing.length} header(s): ${missing.join(", ")}`);
  }
}

verifyEndpointKeys(bulkRowsRoute, "compare/rows");
verifyEndpointKeys(singleRowRoute, "compare/row");

console.log(`OK: CSV header order + returned row keys verified (${clientHeaders.length} columns).`);

