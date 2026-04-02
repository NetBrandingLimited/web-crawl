/**
 * Verifies multi-page cursor behavior for Phase 2 compare pagination.
 *
 * Production behavior (compare/route.ts, jsonPaginated path):
 * - Compute counts and `totalDiffRows = changed + new_in_b + removed_in_a`.
 * - For each page:
 *   - endExclusiveGlobal = min(totalDiffRows, offset + pageLimit)
 *   - Compute per-block slices by global offset
 *   - nextOffset = offset + pageRows.length
 *   - next_cursor = encodeCompareJsonCursor(nextOffset)
 *
 * We verify concatenation of multiple pages equals reference full sort.
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
    items.push({ url, i: items.length });
  }

  // shuffle insertion order; restore `i` after shuffle like production insertion index
  for (let j = items.length - 1; j > 0; j--) {
    const k = randomInt(0, j);
    const tmp = items[j];
    items[j] = items[k];
    items[k] = tmp;
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

let iterations = 1200;
if (process.env.ITERATIONS) {
  const n = Number(process.env.ITERATIONS);
  if (Number.isFinite(n) && n > 0) iterations = n;
}

for (let t = 0; t < iterations; t++) {
  const changedN = randomInt(0, 120);
  const newN = randomInt(0, 120);
  const removedN = randomInt(0, 120);
  const total = changedN + newN + removedN;
  if (total === 0) continue;

  const changed = makeBlock(changedN, 100);
  const newInB = makeBlock(newN, 200);
  const removed = makeBlock(removedN, 300);

  const changedSorted = [...changed].sort(urlThenIAsc);
  const newSorted = [...newInB].sort(urlThenIAsc);
  const removedSorted = [...removed].sort(urlThenIAsc);

  const referenceAll = [...changedSorted, ...newSorted, ...removedSorted];

  // Simulate server pagination
  const pageLimit = randomInt(1, 50);
  let offset = 0;
  const actualAll = [];

  while (offset < referenceAll.length) {
    const totalDiffRows = referenceAll.length;
    const endExclusiveGlobal = Math.min(totalDiffRows, offset + pageLimit);

    const changed = referenceAll.slice(0, changedSorted.length); // not used directly; keep consistent boundaries
    void changed;

    const changedLen = changedSorted.length;
    const newLen = newSorted.length;
    const removedLen = removedSorted.length;
    void removedLen;

    const changedStart = offset;
    const changedEnd = Math.min(changedLen, endExclusiveGlobal);
    const newStartGlobal = Math.max(changedLen, offset);
    const newEndGlobal = Math.min(changedLen + newLen, endExclusiveGlobal);
    const removedStartGlobal = Math.max(changedLen + newLen, offset);
    const removedEndGlobal = Math.min(totalDiffRows, endExclusiveGlobal);

    const changedSlice =
      changedStart < changedEnd ? selectUrlSlice(changedSorted, changedStart, changedEnd - changedStart) : [];
    const newSlice =
      newStartGlobal < newEndGlobal
        ? selectUrlSlice(newSorted, newStartGlobal - changedLen, newEndGlobal - newStartGlobal)
        : [];
    const removedSlice =
      removedStartGlobal < removedEndGlobal
        ? selectUrlSlice(removedSorted, removedStartGlobal - (changedLen + newLen), removedEndGlobal - removedStartGlobal)
        : [];

    const pageRows = [...changedSlice, ...newSlice, ...removedSlice];
    actualAll.push(...pageRows);

    const nextOffset = offset + pageRows.length;
    if (nextOffset === offset) {
      console.error("Pagination made no progress (should be impossible).");
      process.exit(1);
    }
    offset = nextOffset;
  }

  if (!eqArr(referenceAll, actualAll)) {
    console.error("Mismatch detected (multipage pagination).");
    console.error({ changedN, newN, removedN, pageLimit });
    console.error({ referenceAll, actualAll });
    process.exit(1);
  }
}

console.log(`OK: multi-page pagination verified for ${iterations} randomized cases.`);

