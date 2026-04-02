/**
 * Verifies the global pagination selection logic used in:
 * `src/app/api/v1/crawl-jobs/compare/route.ts`
 *
 * Reference algorithm:
 * - sort each block by (url asc, i asc)
 * - concatenate in order: changed -> new_in_b -> removed_in_a
 * - slice [offset, offset+limit)
 *
 * Implementation under test:
 * - uses the same `selectUrlSlice` heap algorithm per block
 * - slices within each block based on global offset/limit
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

  // Mirror production heuristic
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
    if (keyCmp(item, heap[0]) < 0) {
      heap[0] = item;
      heapifyDown(0);
    }
  }

  heap.sort(urlThenIAsc);
  return keepSmallestPrefix ? heap.slice(start, endExclusive) : heap.slice(0, wantCount);
}

function randomInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function makeBlock(n, offsetSeed) {
  const used = new Set();
  const items = [];
  while (items.length < n) {
    const v = randomInt(0, 9999);
    const url = pad4((v + offsetSeed) % 10000);
    if (used.has(url)) continue;
    used.add(url);
    items.push({ url, i: items.length, id: `x${offsetSeed}-${items.length}` });
  }
  // shuffle insertion order
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  for (let i = 0; i < items.length; i++) items[i].i = i;
  return items;
}

function eqArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].url !== b[i].url || a[i].i !== b[i].i) return false;
  }
  return true;
}

let iterations = 2000;
if (process.env.ITERATIONS) {
  const n = Number(process.env.ITERATIONS);
  if (Number.isFinite(n) && n > 0) iterations = n;
}

for (let t = 0; t < iterations; t++) {
  const changedN = randomInt(0, 80);
  const newN = randomInt(0, 80);
  const removedN = randomInt(0, 80);
  const total = changedN + newN + removedN;
  if (total === 0) continue;

  const changed = makeBlock(changedN, 10);
  const newInB = makeBlock(newN, 20);
  const removed = makeBlock(removedN, 30);

  const changedSorted = [...changed].sort(urlThenIAsc);
  const newSorted = [...newInB].sort(urlThenIAsc);
  const removedSorted = [...removed].sort(urlThenIAsc);

  const offset = randomInt(0, total - 1);
  const limit = randomInt(1, 30);
  const endExclusiveGlobal = Math.min(total, offset + limit);

  // Reference
  const ref = [...changedSorted, ...newSorted, ...removedSorted].slice(offset, endExclusiveGlobal);

  // Under test (mirrors compare/route.ts)
  const changedLen = changedSorted.length;
  const newLen = newSorted.length;
  const removedLen = removedSorted.length;
  const changedStart = offset;
  const changedEnd = Math.min(changedLen, endExclusiveGlobal);
  const newStartGlobal = Math.max(changedLen, offset);
  const newEndGlobal = Math.min(changedLen + newLen, endExclusiveGlobal);
  const removedStartGlobal = Math.max(changedLen + newLen, offset);
  const removedEndGlobal = Math.min(total, endExclusiveGlobal);

  const changedSlice =
    changedStart < changedEnd ? selectUrlSlice(changed, changedStart, changedEnd - changedStart) : [];
  const newSlice =
    newStartGlobal < newEndGlobal ? selectUrlSlice(newInB, newStartGlobal - changedLen, newEndGlobal - newStartGlobal) : [];
  const removedSlice =
    removedStartGlobal < removedEndGlobal
      ? selectUrlSlice(removed, removedStartGlobal - (changedLen + newLen), removedEndGlobal - removedStartGlobal)
      : [];

  const actual = [...changedSlice, ...newSlice, ...removedSlice];

  if (!eqArr(ref, actual)) {
    console.error("Mismatch detected (global pagination slice).");
    console.error({ changedN, newN, removedN, offset, limit });
    console.error({ ref, actual });
    process.exit(1);
  }
}

console.log(`OK: global pagination slice verified for ${iterations} randomized cases.`);

