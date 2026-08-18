export const DEFAULT_METADATA_PAGE_SIZE = 100;
export const SETTINGS_VERSION = 2;

function toNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(Math.trunc(parsed), 0);
}

export function normalizeExportRange(startIndex, maxImages) {
  const start = toNonNegativeInteger(startIndex);
  const count = toNonNegativeInteger(maxImages);
  return {
    startIndex: start,
    maxImages: count,
    endIndex: count > 0 ? start + count : null
  };
}

export function migrateSettings(settings, defaults) {
  const stored = settings && typeof settings === "object" ? settings : {};
  const merged = { ...defaults, ...stored };

  if (stored.settingsVersion === SETTINGS_VERSION) {
    return merged;
  }

  const startIndex = toNonNegativeInteger(merged.startIndex);
  const oldEndIndex = toNonNegativeInteger(merged.maxImages);

  // Version 1 treated "Max images" as an absolute end index even though the
  // UI described it as a count. Preserve the intended batch size on upgrade.
  if (startIndex > 0 && oldEndIndex > startIndex) {
    merged.maxImages = oldEndIndex - startIndex;
  }

  return { ...merged, settingsVersion: SETTINGS_VERSION };
}

export function buildMetadataPageUrl(endpoint, limit, cursor = null) {
  const url = new URL(endpoint);
  url.searchParams.set("limit", String(Math.max(toNonNegativeInteger(limit, 1), 1)));
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    url.searchParams.set("after", String(cursor));
  } else {
    url.searchParams.delete("after");
  }
  return url.toString();
}

function readCursor(data) {
  return data?.cursor ?? data?.next_cursor ?? data?.nextCursor ?? null;
}

function abortError() {
  const error = new Error("Export stopped.");
  error.name = "AbortError";
  return error;
}

export async function collectMetadataRange({
  endpoint,
  startIndex = 0,
  maxImages = 0,
  pageSize = DEFAULT_METADATA_PAGE_SIZE,
  fetchPage,
  onProgress,
  shouldStop
}) {
  if (typeof fetchPage !== "function") {
    throw new TypeError("fetchPage must be a function.");
  }

  const range = normalizeExportRange(startIndex, maxImages);
  const boundedPageSize = Math.max(toNonNegativeInteger(pageSize, DEFAULT_METADATA_PAGE_SIZE), 1);
  const selectedItems = [];
  const seenCursors = new Set();
  let cursor = null;
  let scanned = 0;
  let pages = 0;
  let exhausted = false;

  while (range.endIndex === null || scanned < range.endIndex) {
    if (shouldStop?.()) throw abortError();

    const remainingToEnd = range.endIndex === null
      ? boundedPageSize
      : Math.max(range.endIndex - scanned, 1);
    const requestLimit = Math.min(boundedPageSize, remainingToEnd);
    const url = buildMetadataPageUrl(endpoint, requestLimit, cursor);
    const data = await fetchPage(url, {
      cursor,
      page: pages + 1,
      requestLimit,
      scanned
    });

    if (shouldStop?.()) throw abortError();

    const pageItems = Array.isArray(data?.items) ? data.items : [];
    const pageStart = scanned;
    pages++;

    for (let offset = 0; offset < pageItems.length; offset++) {
      const absoluteIndex = pageStart + offset;
      if (absoluteIndex < range.startIndex) continue;
      if (range.endIndex !== null && absoluteIndex >= range.endIndex) break;
      selectedItems.push(pageItems[offset]);
    }

    scanned += pageItems.length;
    await onProgress?.({
      pages,
      scanned,
      selected: selectedItems.length,
      targetIndex: range.endIndex
    });

    if (range.maxImages > 0 && selectedItems.length >= range.maxImages) {
      break;
    }

    const nextCursor = readCursor(data);
    if (pageItems.length === 0 || nextCursor === null || nextCursor === undefined || nextCursor === "") {
      exhausted = true;
      break;
    }

    const cursorKey = String(nextCursor);
    if (seenCursors.has(cursorKey)) {
      throw new Error(`Metadata pagination repeated cursor: ${cursorKey}`);
    }
    seenCursors.add(cursorKey);
    cursor = cursorKey;
  }

  return {
    items: selectedItems,
    startIndex: range.startIndex,
    requestedCount: range.maxImages,
    scanned,
    pages,
    exhausted
  };
}
