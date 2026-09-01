import { createTempZipFile } from "./opfs-temp.mjs";
import { buildImageRequest } from "./security.mjs";
import { sanitizeZipBaseName, ZipStreamWriter } from "./zip-writer.mjs";

let stopRequested = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(base, amount) {
  return base + Math.floor(Math.random() * (amount + 1));
}

function extensionFromType(contentType) {
  if (!contentType) return "";
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg"
  };
  return extensions[normalized] || "";
}

function extensionFromUrl(url) {
  if (!url) return "";
  try {
    const match = new URL(url).pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match?.[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function makeFilenameFlat(index, item, blob) {
  const base = `img_${String(index).padStart(6, "0")}`;
  const extension = extensionFromType(blob?.type) || extensionFromUrl(item?.url) || "png";
  return `${base}.${extension}`;
}

async function fetchBlob(url, headers) {
  const request = buildImageRequest(url, headers);
  const response = await fetch(request.url, request.init);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.blob();
}

function waitForDownloadCompletion(downloadId) {
  if (!chrome.downloads?.onChanged || !chrome.downloads?.search) {
    return sleep(60_000);
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve();
    };

    const inspect = (item) => {
      if (item?.state === "complete") finish();
      if (item?.state === "interrupted") {
        finish(new Error(`ZIP download was interrupted${item.error ? `: ${item.error}` : "."}`));
      }
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      inspect({ state: delta.state?.current, error: delta.error?.current });
    };

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(
      (items) => inspect(items[0]),
      (error) => finish(error)
    );
  });
}

async function downloadSingleFile(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  try {
    let downloadId;
    if (chrome.downloads?.download) {
      downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      await waitForDownloadCompletion(downloadId);
    } else {
      const response = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_URL",
        url: blobUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      if (!response?.ok) throw new Error(response?.error || "ZIP download failed in background.");
      downloadId = response.id;
    }
    return downloadId;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function runExport({ settings, endpoint, headers, metadata }) {
  stopRequested = false;

  if (!endpoint) {
    chrome.runtime.sendMessage({
      type: "EXPORT_NEED_AUTH",
      error: "No endpoint detected. Open chatgpt.com/images and click Start export again."
    });
    return;
  }

  const zipBaseName = sanitizeZipBaseName(settings.folder || "ChatGPT_Images");
  const zipFilename = `${zipBaseName}.zip`;
  const startIndex = Math.max(Number(metadata?.startIndex ?? settings.startIndex ?? 0), 0);
  const delayMs = Number(settings.delayMs || 0);
  const jitterMs = Number(settings.jitterMs || 0);
  const retries = Number(settings.retries || 0);
  const concurrency = Math.min(Math.max(Number(settings.concurrency || 4), 1), 8);
  const downloadMetadata = Boolean(settings.downloadMetadata);
  const progress = { current: 0, total: 0, ok: 0, fail: 0 };
  const failures = [];
  const startedAt = Date.now();

  const withEstimates = (value) => {
    const elapsedMs = Date.now() - startedAt;
    const processed = Number(value.current || 0);
    const total = Number(value.total || 0);
    if (processed <= 0 || total <= 0) {
      return { ...value, elapsedMs, estimatedTotalMs: null, remainingMs: null };
    }
    const averageMs = elapsedMs / processed;
    return {
      ...value,
      elapsedMs,
      estimatedTotalMs: averageMs * total,
      remainingMs: averageMs * Math.max(total - processed, 0)
    };
  };

  if (!Array.isArray(metadata?.items)) {
    chrome.runtime.sendMessage({
      type: "EXPORT_NEED_AUTH",
      error: "No paginated metadata was supplied for this export. Please start again."
    });
    return;
  }

  const items = metadata.items;
  progress.total = items.length;
  chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", progress: withEstimates(progress) });

  let temp = null;
  try {
    temp = await createTempZipFile();
    const zip = new ZipStreamWriter(temp.writable);

    if (downloadMetadata) {
      await zip.addText("metadata.json", JSON.stringify({
        fetchedAt: new Date().toISOString(),
        endpointUsed: endpoint,
        total: items.length,
        range: {
          startIndex,
          requestedCount: metadata.requestedCount,
          scanned: metadata.scanned,
          pages: metadata.pages,
          exhausted: metadata.exhausted
        },
        data: { items }
      }, null, 2));
    }

    for (let batchStart = 0; batchStart < items.length && !stopRequested; batchStart += concurrency) {
      const batchEnd = Math.min(batchStart + concurrency, items.length);
      const batch = [];

      for (let index = batchStart; index < batchEnd; index++) {
        batch.push((async () => {
          const item = items[index];
          const url = item?.url;
          const exportIndex = startIndex + index;
          if (!url) return { index, exportIndex, ok: false, reason: "missing url", item };

          for (let attempt = 0; attempt <= retries && !stopRequested; attempt++) {
            try {
              let blob;
              try {
                blob = await fetchBlob(url, headers);
              } catch (error) {
                if (error?.status !== 401 && error?.status !== 403) throw error;
                blob = await fetchBlob(url, null);
              }
              return {
                index,
                exportIndex,
                ok: true,
                blob,
                filename: makeFilenameFlat(exportIndex, item, blob)
              };
            } catch (error) {
              if (attempt >= retries) {
                return { index, exportIndex, ok: false, url, status: error?.status, error: String(error) };
              }
              await sleep(500 + (attempt + 1) * 350);
            }
          }
          return { index, exportIndex, ok: false, url, error: "Stopped" };
        })());
      }

      const results = await Promise.all(batch);
      results.sort((left, right) => left.index - right.index);
      for (const result of results) {
        if (stopRequested) break;
        if (result.ok) {
          await zip.addBlob(result.filename, result.blob);
          progress.ok++;
        } else {
          progress.fail++;
          failures.push(result);
        }
        progress.current++;
        chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", progress: withEstimates(progress) });
        if (!stopRequested) await sleep(jitter(delayMs, jitterMs));
      }
    }

    if (stopRequested) {
      await temp.writable.abort().catch(() => {});
      await temp.root.removeEntry(temp.tempName).catch(() => {});
      temp = null;
      chrome.runtime.sendMessage({ type: "EXPORT_STOPPED", progress: withEstimates(progress) });
      return;
    }

    if (downloadMetadata) {
      await zip.addText("failures.json", JSON.stringify({
        fetchedAt: new Date().toISOString(),
        failures
      }, null, 2));
    }

    await zip.finish();
    const zipFile = await temp.handle.getFile();
    const zipBlob = new Blob([zipFile], { type: "application/zip" });
    await downloadSingleFile(zipBlob, zipFilename);
    await temp.root.removeEntry(temp.tempName);
    temp = null;
    chrome.runtime.sendMessage({ type: "EXPORT_DONE", progress: withEstimates(progress) });
  } catch (error) {
    if (temp?.writable) await temp.writable.abort().catch(() => {});
    if (temp?.root && temp?.tempName) await temp.root.removeEntry(temp.tempName).catch(() => {});
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "OFFSCREEN_START") {
    runExport(message).catch((error) => {
      chrome.runtime.sendMessage({ type: "EXPORT_NEED_AUTH", error: String(error) });
    });
  }

  if (message.type === "OFFSCREEN_STOP") {
    stopRequested = true;
  }
});
