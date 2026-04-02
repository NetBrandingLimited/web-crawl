const fs = require("node:fs");
const path = require("node:path");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function extractPushOrder(source) {
  // Extract in order all tokens passed to `push("token")`.
  // This is robust for our codebase because changed_fields builders use the same pattern.
  const re = /push\(\s*"([^"]+)"\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

function assertSameArray(a, b, label) {
  if (a.length !== b.length) {
    throw new Error(`${label}: length mismatch ${a.length} vs ${b.length}`);
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`${label}: mismatch at ${i}: "${a[i]}" vs "${b[i]}"`);
    }
  }
}

const root = path.join(__dirname, "..");
const singleRow = read(path.join(root, "src/app/api/v1/crawl-jobs/compare/row/route.ts"));
const bulkRows = read(path.join(root, "src/app/api/v1/crawl-jobs/compare/rows/route.ts"));

// Both endpoints build `changed_fields` for the "changed" case only using the same token order.
const orderSingle = extractPushOrder(singleRow);
const orderBulk = extractPushOrder(bulkRows);

assertSameArray(orderSingle, orderBulk, "changed_fields token push order");

console.log(`OK: changed_fields token order matches (${orderSingle.length} tokens).`);

