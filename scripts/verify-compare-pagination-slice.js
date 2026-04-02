/**
 * Verifies the heap-based `selectUrlSlice` algorithm used in:
 * `src/app/api/v1/crawl-jobs/compare/route.ts`
 *
 * We compare against the reference implementation:
 * "sort everything by (url asc, i asc) then slice".
 */

function urlThenIAsc(a, b) {
  if (a.url < b.url) return -1;
  if (a.url > b.url) return 1;
  return a.i - b.i;
}

function selectUrlSlice(items, start, count) {
  if (count <= 0) return [];
  const n = items.length;
  if (start >= n) return [];
  const endExclusive = Math.min(n, start + count);
  const wantCount = endExclusive - start;

  // Mirror the production heuristic:
  // - Keep smallest endExclusive prefix when it's cheaper.
  // - Otherwise keep largest tail (n - start), then slice first wantCount.
  const keepSmallestPrefix = endExclusive <= n - start;
  const heapSize = keepSmallestPrefix ? endExclusive : n - start;

  const keyCmp = keepSmallestPrefix ? urlThenIAsc : (a, b) => -urlThenIAsc(a, b);

  const heap = [];
  const isGreater = (a, b) => keyCmp(a, b) > 0;

  const heapifyUp = (idx) => {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!isGreater(heap[idx], heap[parent])) break;
      const tmp = heap[parent];
      heap[parent] = heap[idx];
      heap[idx] = tmp;
      idx = parent;
    }
  };

  const heapifyDown = (idx) => {
    const len = heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let largest = idx;
      if (left < len && isGreater(heap[left], heap[largest])) largest = left;
      if (right < len && isGreater(heap[right], heap[largest])) largest = right;
      if (largest === idx) break;
      const tmp = heap[largest];
      heap[largest] = heap[idx];
      heap[idx] = tmp;
      idx = largest;
    }
  };

  for (const item of items) {
    if (heap.length < heapSize) {
      heap.push(item);
      heapifyUp(heap.length - 1);
      continue;
    }

    // Keep only the smallest `heapSize` items under `keyCmp`.
    if (keyCmp(item, heap[0]) < 0) {
      heap[0] = item;
      heapifyDown(0);
    }
  }

  // Sort kept set ascending by true ordering, then slice out requested range.
  heap.sort(urlThenIAsc);
  return keepSmallestPrefix ? heap.slice(start, endExclusive) : heap.slice(0, wantCount);
}

function randomInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function itemsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].url !== b[i].url || a[i].i !== b[i].i) return false;
  }
  return true;
}

let iterations = 2500;
if (process.env.ITERATIONS) {
  const n = Number(process.env.ITERATIONS);
  if (Number.isFinite(n) && n > 0) iterations = n;
}

for (let t = 0; t < iterations; t++) {
  const n = randomInt(1, 120);

  // Create unique url strings.
  const used = new Set();
  const items = [];
  while (items.length < n) {
    const v = randomInt(0, 9999);
    const url = pad4(v);
    if (used.has(url)) continue;
    used.add(url);
    items.push({ url, i: items.length });
  }

  // Shuffle insertion order (i is tie-breaker, so we must shuffle array only).
  // We'll rebuild i to match insertion order (array index) like in production.
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  for (let i = 0; i < items.length; i++) items[i].i = i;

  const start = randomInt(0, n - 1);
  const maxCount = n - start;
  const count = randomInt(0, maxCount);

  const expected = [...items].sort(urlThenIAsc).slice(start, start + count);
  const actual = selectUrlSlice(items, start, count);

  if (!itemsEqual(expected, actual)) {
    console.error("Mismatch detected");
    console.error({ n, start, count, expected, actual });
    process.exit(1);
  }
}

console.log(`OK: selectUrlSlice verified for ${iterations} randomized cases.`);

