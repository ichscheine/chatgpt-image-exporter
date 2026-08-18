import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMetadataPageUrl,
  collectMetadataRange,
  migrateSettings,
  normalizeExportRange,
  SETTINGS_VERSION
} from "../export-range.mjs";

function makePagedFetcher(totalItems) {
  const calls = [];
  const allItems = Array.from({ length: totalItems }, (_, id) => ({ id }));

  return {
    calls,
    async fetchPage(url) {
      const parsed = new URL(url);
      const limit = Number(parsed.searchParams.get("limit"));
      const start = Number(parsed.searchParams.get("after") || 0);
      const items = allItems.slice(start, start + limit);
      const nextIndex = start + items.length;
      calls.push({ limit, start });
      return {
        items,
        cursor: nextIndex < allItems.length ? String(nextIndex) : null
      };
    }
  };
}

test("buildMetadataPageUrl bounds each request and replaces captured pagination", () => {
  const first = new URL(buildMetadataPageUrl(
    "https://chatgpt.com/backend-api/my/recent/image_gen?limit=25&after=stale",
    100
  ));
  assert.equal(first.searchParams.get("limit"), "100");
  assert.equal(first.searchParams.has("after"), false);

  const next = new URL(buildMetadataPageUrl(first, 12, "cursor value"));
  assert.equal(next.searchParams.get("limit"), "12");
  assert.equal(next.searchParams.get("after"), "cursor value");
});

test("start 7500 with count 12 never makes an oversized metadata request", async () => {
  const fake = makePagedFetcher(10_000);
  const result = await collectMetadataRange({
    endpoint: "https://chatgpt.com/backend-api/my/recent/image_gen?limit=25",
    startIndex: 7_500,
    maxImages: 12,
    pageSize: 100,
    fetchPage: fake.fetchPage
  });

  assert.deepEqual(result.items.map((item) => item.id),
    Array.from({ length: 12 }, (_, offset) => 7_500 + offset));
  assert.equal(result.pages, 76);
  assert.equal(result.scanned, 7_512);
  assert.equal(Math.max(...fake.calls.map((call) => call.limit)), 100);
  assert.deepEqual(fake.calls.at(-1), { start: 7_500, limit: 12 });
});

test("count semantics work across a page boundary", async () => {
  const fake = makePagedFetcher(500);
  const result = await collectMetadataRange({
    endpoint: "https://chatgpt.com/backend-api/my/recent/image_gen",
    startIndex: 95,
    maxImages: 12,
    pageSize: 100,
    fetchPage: fake.fetchPage
  });

  assert.deepEqual(result.items.map((item) => item.id),
    Array.from({ length: 12 }, (_, offset) => 95 + offset));
  assert.deepEqual(fake.calls, [
    { start: 0, limit: 100 },
    { start: 100, limit: 7 }
  ]);
});

test("zero count exports everything remaining after the start index", async () => {
  const fake = makePagedFetcher(205);
  const result = await collectMetadataRange({
    endpoint: "https://chatgpt.com/backend-api/my/recent/image_gen",
    startIndex: 195,
    maxImages: 0,
    pageSize: 100,
    fetchPage: fake.fetchPage
  });

  assert.deepEqual(result.items.map((item) => item.id),
    Array.from({ length: 10 }, (_, offset) => 195 + offset));
  assert.equal(result.exhausted, true);
});

test("repeated cursors fail instead of looping forever", async () => {
  await assert.rejects(
    collectMetadataRange({
      endpoint: "https://chatgpt.com/backend-api/my/recent/image_gen",
      maxImages: 0,
      fetchPage: async () => ({ items: [{ id: 1 }], cursor: "same" })
    }),
    /repeated cursor/
  );
});

test("range normalization and v1 settings migration preserve batch intent", () => {
  assert.deepEqual(normalizeExportRange(7_500, 12), {
    startIndex: 7_500,
    maxImages: 12,
    endIndex: 7_512
  });

  assert.deepEqual(migrateSettings(
    { startIndex: 7_500, maxImages: 7_512, folder: "Images" },
    { startIndex: 0, maxImages: 0, folder: "Default" }
  ), {
    startIndex: 7_500,
    maxImages: 12,
    folder: "Images",
    settingsVersion: SETTINGS_VERSION
  });
});
