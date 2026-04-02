const assert = require("node:assert");

/**
 * Roundtrip validation for:
 * - encodeCompareJsonCursor(offset)
 * - parseCompareJsonCursor(raw)
 *
 * Mirrors implementation in `src/app/api/v1/crawl-jobs/compare/route.ts`.
 */

function encodeCompareJsonCursor(offset) {
  // `base64url` like Node's Buffer supports.
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

function parseCompareJsonCursor(raw) {
  if (raw == null || raw === "") return 0;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    const o = Number(parsed?.o);
    if (!Number.isFinite(o) || o < 0 || o > 50_000_000) return null;
    return Math.floor(o);
  } catch {
    return null;
  }
}

function randomInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

// Roundtrip a bunch of offsets.
for (let i = 0; i < 5000; i++) {
  const offset = randomInt(0, 50_000_000);
  const c = encodeCompareJsonCursor(offset);
  const decoded = parseCompareJsonCursor(c);
  assert.strictEqual(decoded, offset);
}

// Empty/absent should decode to 0 (matches route behavior).
assert.strictEqual(parseCompareJsonCursor(null), 0);
assert.strictEqual(parseCompareJsonCursor(undefined), 0);
assert.strictEqual(parseCompareJsonCursor(""), 0);

// Invalid cursor should decode to null.
assert.strictEqual(parseCompareJsonCursor("not-base64url"), null);

console.log("OK: compare cursor encode/decode roundtrip verified.");

