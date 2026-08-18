let stopRequested = false;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(base, j) {
  return base + Math.floor(Math.random() * (j + 1));
}

function extensionFromType(contentType) {
  if (!contentType) return "";
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg"
  };
  return map[ct] || "";
}

function extensionFromUrl(url) {
  if (!url) return "";
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    return m?.[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}

async function fetchBlob(url, headers) {
  const res = await fetch(url, {
    method: "GET",
    headers: headers || undefined,
    credentials: "include"
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return await res.blob();
}

function makeFilenameFlat(index, item, blob) {
  // Keep names short to avoid noisy download panel entries.
  const url = item?.url || "";
  const base = `img_${String(index).padStart(6, "0")}`;
  const ext = extensionFromType(blob?.type) || extensionFromUrl(url) || "png";
  return `${base}.${ext}`;
}

async function downloadBlobToFile(blob, filename, folder) {
  const blobUrl = URL.createObjectURL(blob);
  try {
    const request = {
      type: "DOWNLOAD_URL",
      url: blobUrl,
      filename: `${folder}/${filename}`,
      conflictAction: "uniquify",
      saveAs: false
    };
    let id;
    if (chrome.downloads?.download) {
      id = await chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        conflictAction: request.conflictAction,
        saveAs: request.saveAs
      });
    } else {
      const res = await chrome.runtime.sendMessage(request);
      if (!res?.ok) {
        throw new Error(res?.error || "Download failed in background.");
      }
      id = res.id;
    }
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

async function downloadJsonToFile(obj, filename, folder) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  return downloadBlobToFile(blob, filename, folder);
}

async function runExport({ tabId, settings, endpoint, headers, metadata }) {
  stopRequested = false;

  if (!endpoint) {
    chrome.runtime.sendMessage({
      type: "EXPORT_NEED_AUTH",
      error: "No endpoint detected. Open chatgpt.com/images and click Start export again."
    });
    return;
  }

  // If we don’t have authorization header, the metadata endpoint may 401.
  // We can still try; some sessions might work with cookies only.
  const folder = settings.folder || "ChatGPT_Images";
  const startIndex = Math.max(Number(metadata?.startIndex ?? settings.startIndex ?? 0), 0);
  const delayMs = Number(settings.delayMs || 0);
  const jitterMs = Number(settings.jitterMs || 0);
  const retries = Number(settings.retries || 0);
  const concurrency = Math.min(Math.max(Number(settings.concurrency || 4), 1), 8);
  const downloadMetadata = !!settings.downloadMetadata;

  let progress = { current: 0, total: 0, ok: 0, fail: 0 };
  const failures = [];
  const startedAt = Date.now();

  function withEstimates(p) {
    const elapsedMs = Date.now() - startedAt;
    const processed = Number(p.current || 0);
    const total = Number(p.total || 0);
    if (processed <= 0 || total <= 0) {
      return { ...p, elapsedMs, estimatedTotalMs: null, remainingMs: null };
    }

    const avgMsPerItem = elapsedMs / processed;
    const remainingItems = Math.max(total - processed, 0);
    return {
      ...p,
      elapsedMs,
      estimatedTotalMs: avgMsPerItem * total,
      remainingMs: avgMsPerItem * remainingItems
    };
  }

  if (!Array.isArray(metadata?.items)) {
    chrome.runtime.sendMessage({
      type: "EXPORT_NEED_AUTH",
      error: "No paginated metadata was supplied for this export. Please start again."
    });
    return;
  }

  const items = metadata.items;
  const total = items.length;
  const end = total;
  const totalPlanned = total;
  progress.total = totalPlanned;

  chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", progress: withEstimates(progress) });

  // Export metadata early (so you have it even if downloads get interrupted)
  if (downloadMetadata) {
    await downloadJsonToFile({
      fetchedAt: new Date().toISOString(),
      endpointUsed: endpoint,
      total,
      range: {
        startIndex,
        requestedCount: metadata.requestedCount,
        scanned: metadata.scanned,
        pages: metadata.pages,
        exhausted: metadata.exhausted
      },
      data: { items }
    }, "metadata.json", folder);
  }

  // 2) Download each image using bounded concurrency
  let nextIndex = 0;
  let processed = 0;

  function emitProgress() {
    progress.current = processed;
    chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", progress: withEstimates(progress) });
  }

  async function processOne(i) {
    const item = items[i];
    const url = item?.url;
    const exportIndex = startIndex + i;

    if (!url) {
      progress.fail++;
      failures.push({ i: exportIndex, reason: "missing url", item });
      return;
    }

    let attempt = 0;
    let ok = false;

    while (attempt <= retries && !ok && !stopRequested) {
      attempt++;
      try {
        // Some URLs might be cross-origin or not require auth; try with headers first, then without.
        let blob;
        try {
          blob = await fetchBlob(url, headers);
        } catch (e) {
          if (e?.status === 401 || e?.status === 403) {
            // Try without headers (sometimes signed URLs / CDN do not want auth header)
            blob = await fetchBlob(url, null);
          } else {
            throw e;
          }
        }

        const filename = makeFilenameFlat(exportIndex, item, blob);
        await downloadBlobToFile(blob, filename, folder);

        progress.ok++;
        ok = true;
      } catch (e) {
        const status = e?.status;
        if (attempt > retries) {
          progress.fail++;
          failures.push({ i: exportIndex, url, status, error: String(e) });
        } else {
          // Backoff
          await sleep(500 + attempt * 350);
        }
      }
    }
  }

  async function worker() {
    while (!stopRequested) {
      const i = nextIndex;
      if (i >= end) break;
      nextIndex++;

      await processOne(i);
      processed++;
      emitProgress();

      if (!stopRequested) {
        await sleep(jitter(delayMs, jitterMs));
      }
    }
  }

  if (totalPlanned > 0) {
    const workerCount = Math.min(concurrency, totalPlanned);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  // Export failures log
  if (downloadMetadata) {
    await downloadJsonToFile({ fetchedAt: new Date().toISOString(), failures }, "failures.json", folder);
  }

  chrome.runtime.sendMessage({ type: "EXPORT_DONE", progress: withEstimates(progress) });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "OFFSCREEN_START") {
    runExport(msg).catch((e) => {
      chrome.runtime.sendMessage({ type: "EXPORT_NEED_AUTH", error: String(e) });
    });
  }

  if (msg.type === "OFFSCREEN_STOP") {
    stopRequested = true;
  }
});
