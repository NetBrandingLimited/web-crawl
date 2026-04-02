const fs = require("node:fs");
const path = require("node:path");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: missing expected snippet:\n${needle}`);
  }
}

const root = path.join(__dirname, "..");
const clientPage = read(path.join(root, "src/app/crawl/page.tsx"));

// 1) Ensure the full export CSV uses the header list order.
assertIncludes(
  clientPage,
  "function downloadFilteredCompareFullCsv()",
  "downloadFilteredCompareFullCsv",
);
assertIncludes(
  clientPage,
  "const lines = [COMPARE_FULL_CSV_HEADERS.join(\",\")];",
  "downloadFilteredCompareFullCsv header line",
);
assertIncludes(
  clientPage,
  "lines.push(COMPARE_FULL_CSV_HEADERS.map((f) => escapeCsvCell(details[f])).join(\",\"));",
  "downloadFilteredCompareFullCsv row mapping",
);

// 2) Ensure page-only export uses the same mapping strategy.
assertIncludes(clientPage, "function downloadVisibleComparePageCsv()", "downloadVisibleComparePageCsv");
assertIncludes(
  clientPage,
  "const lines = [COMPARE_FULL_CSV_HEADERS.join(\",\")];",
  "downloadVisibleComparePageCsv header line",
);
assertIncludes(
  clientPage,
  "lines.push(COMPARE_FULL_CSV_HEADERS.map((f) => escapeCsvCell(details[f])).join(\",\"));",
  "downloadVisibleComparePageCsv row mapping",
);

// 3) Ensure bulk-details loader maps server `row` object keys using the same header list.
assertIncludes(
  clientPage,
  "function fetchCompareRowDetailsBulkBatched(",
  "fetchCompareRowDetailsBulkBatched",
);
assertIncludes(
  clientPage,
  "const details = Object.fromEntries(",
  "bulk details: Object.fromEntries",
);
assertIncludes(
  clientPage,
  "COMPARE_FULL_CSV_HEADERS.map((f) => [f, String((row as Record<string, unknown>)[f] ?? \"\")])",
  "bulk details: maps headers -> [key,value]",
);

// 4) Ensure single-details loader also uses the same header list iteration.
assertIncludes(
  clientPage,
  "ensureCompareRowDetails",
  "ensureCompareRowDetails present",
);
assertIncludes(
  clientPage,
  "COMPARE_FULL_CSV_HEADERS.map((h) => [h, String((row as Record<string, unknown>)[h] ?? \"\")])",
  "single details: maps headers -> [key,value]",
);

console.log("OK: compare export pipeline (header order + details key mapping) verified by static scan.");

