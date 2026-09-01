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
  const url = item?.url || "";
  const base = `img_${String(index).padStart(6, "0")}`;
  const ext = extensionFromType(blob?.type) || extensionFromUrl(url) || "png";
  return `${base}.${ext}`;
}

function sanitizeZipBaseName(value) {
  const cleaned = String(value || "ChatGPT_Images")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "");
  return cleaned || "ChatGPT_Images";
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = ((date.getHours() & 0x1F) << 11) |
                  ((date.getMinutes() & 0x3F) << 5) |
                  ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) |
                  (((date.getMonth() + 1) & 0x0F) << 5) |
                  (date.getDate() & 0x1F);
  return { dosTime, dosDate };
}

function concatUint8Arrays(parts) {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function zip64Extra({ uncompressedSize, compressedSize, localHeaderOffset }, includeSizes, includeOffset) {
  const payloadSize = (includeSizes ? 16 : 0) + (includeOffset ? 8 : 0);
  if (!payloadSize) return new Uint8Array(0);
  const out = new Uint8Array(4 + payloadSize);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, payloadSize, true);
  let p = 4;
  if (includeSizes) {
    view.setBigUint64(p, BigInt(uncompressedSize), true); p += 8;
    view.setBigUint64(p, BigInt(compressedSize), true); p += 8;
  }
  if (includeOffset) {
    view.setBigUint64(p, BigInt(localHeaderOffset), true);
  }
  return out;
}

class ZipStreamWriter {
  constructor(writable) {
    this.writable = writable;
    this.offset = 0;
    this.entries = [];
    this.encoder = new TextEncoder();
  }

  async write(data) {
    await this.writable.write(data);
    this.offset += data.size ?? data.byteLength ?? 0;
  }

  async addBlob(name, blob) {
    const nameBytes = this.encoder.encode(name);
    const size = blob.size;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes);
    // Release the temporary byte copy after CRC calculation; the Blob itself is streamed to OPFS.
    const localOffset = this.offset;
    const needsZip64Size = size >= 0xFFFFFFFF;
    const extra = zip64Extra({
      uncompressedSize: size,
      compressedSize: size,
      localHeaderOffset: localOffset
    }, needsZip64Size, false);
    const { dosTime, dosDate } = dosDateTime();

    const header = new Uint8Array(30 + nameBytes.length + extra.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034B50, true);
    view.setUint16(4, needsZip64Size ? 45 : 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, 0, true);      // STORE, images are already compressed
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, needsZip64Size ? 0xFFFFFFFF : size, true);
    view.setUint32(22, needsZip64Size ? 0xFFFFFFFF : size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, extra.length, true);
    header.set(nameBytes, 30);
    header.set(extra, 30 + nameBytes.length);

    await this.write(header);
    await this.write(blob);

    this.entries.push({
      nameBytes,
      crc,
      size,
      localOffset,
      dosTime,
      dosDate,
      needsZip64Size
    });
  }

  async addText(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    await this.addBlob(name, blob);
  }

  async finish() {
    const centralOffset = this.offset;
    let centralSize = 0;

    for (const e of this.entries) {
      const needsZip64Offset = e.localOffset >= 0xFFFFFFFF;
      const extra = zip64Extra({
        uncompressedSize: e.size,
        compressedSize: e.size,
        localHeaderOffset: e.localOffset
      }, e.needsZip64Size, needsZip64Offset);

      const header = new Uint8Array(46 + e.nameBytes.length + extra.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x02014B50, true);
      view.setUint16(4, 45, true);
      view.setUint16(6, (e.needsZip64Size || needsZip64Offset) ? 45 : 20, true);
      view.setUint16(8, 0x0800, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, e.dosTime, true);
      view.setUint16(14, e.dosDate, true);
      view.setUint32(16, e.crc, true);
      view.setUint32(20, e.needsZip64Size ? 0xFFFFFFFF : e.size, true);
      view.setUint32(24, e.needsZip64Size ? 0xFFFFFFFF : e.size, true);
      view.setUint16(28, e.nameBytes.length, true);
      view.setUint16(30, extra.length, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, needsZip64Offset ? 0xFFFFFFFF : e.localOffset, true);
      header.set(e.nameBytes, 46);
      header.set(extra, 46 + e.nameBytes.length);

      await this.write(header);
      centralSize += header.byteLength;
    }

    const entryCount = this.entries.length;
    const needsZip64 = entryCount >= 0xFFFF || centralOffset >= 0xFFFFFFFF || centralSize >= 0xFFFFFFFF;

    if (needsZip64) {
      const zip64EocdOffset = this.offset;
      const z64 = new Uint8Array(56);
      const z64v = new DataView(z64.buffer);
      z64v.setUint32(0, 0x06064B50, true);
      z64v.setBigUint64(4, 44n, true);
      z64v.setUint16(12, 45, true);
      z64v.setUint16(14, 45, true);
      z64v.setUint32(16, 0, true);
      z64v.setUint32(20, 0, true);
      z64v.setBigUint64(24, BigInt(entryCount), true);
      z64v.setBigUint64(32, BigInt(entryCount), true);
      z64v.setBigUint64(40, BigInt(centralSize), true);
      z64v.setBigUint64(48, BigInt(centralOffset), true);
      await this.write(z64);

      const locator = new Uint8Array(20);
      const lv = new DataView(locator.buffer);
      lv.setUint32(0, 0x07064B50, true);
      lv.setUint32(4, 0, true);
      lv.setBigUint64(8, BigInt(zip64EocdOffset), true);
      lv.setUint32(16, 1, true);
      await this.write(locator);
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, needsZip64 ? 0xFFFF : entryCount, true);
    ev.setUint16(10, needsZip64 ? 0xFFFF : entryCount, true);
    ev.setUint32(12, needsZip64 ? 0xFFFFFFFF : centralSize, true);
    ev.setUint32(16, needsZip64 ? 0xFFFFFFFF : centralOffset, true);
    ev.setUint16(20, 0, true);
    await this.write(eocd);

    await this.writable.close();
  }
}

async function downloadSingleFile(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  try {
    let id;
    if (chrome.downloads?.download) {
      id = await chrome.downloads.download({
        url: blobUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
    } else {
      const res = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_URL",
        url: blobUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      if (!res?.ok) throw new Error(res?.error || "ZIP download failed in background.");
      id = res.id;
    }
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }
}

async function createTempZipFile(baseName) {
  if (!navigator.storage?.getDirectory) {
    throw new Error("This Brave/Chromium build does not expose Origin Private File System storage required for the ZIP export.");
  }
  const root = await navigator.storage.getDirectory();
  const tempName = `${baseName}_${Date.now()}.zip.tmp`;
  const handle = await root.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  return { root, handle, writable, tempName };
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

  const zipBaseName = sanitizeZipBaseName(settings.folder || "ChatGPT_Images");
  const zipFilename = `${zipBaseName}.zip`;
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
  progress.total = total;
  chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", progress: withEstimates(progress) });

  let temp = null;
  try {
    temp = await createTempZipFile(zipBaseName);
    const zip = new ZipStreamWriter(temp.writable);

    if (downloadMetadata) {
      const metadataPayload = {
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
      };
      await zip.addText("metadata.json", JSON.stringify(metadataPayload, null, 2));
    }

    // Fetch in bounded parallel batches, but write to the ZIP in deterministic index order.
    for (let batchStart = 0; batchStart < total && !stopRequested; batchStart += concurrency) {
      const batchEnd = Math.min(batchStart + concurrency, total);
      const batch = [];

      for (let i = batchStart; i < batchEnd; i++) {
        batch.push((async () => {
          const item = items[i];
          const url = item?.url;
          const exportIndex = startIndex + i;

          if (!url) {
            return { i, exportIndex, ok: false, reason: "missing url", item };
          }

          let attempt = 0;
          while (attempt <= retries && !stopRequested) {
            attempt++;
            try {
              let blob;
              try {
                blob = await fetchBlob(url, headers);
              } catch (e) {
                if (e?.status === 401 || e?.status === 403) {
                  blob = await fetchBlob(url, null);
                } else {
                  throw e;
                }
              }
              return {
                i,
                exportIndex,
                ok: true,
                blob,
                filename: makeFilenameFlat(exportIndex, item, blob)
              };
            } catch (e) {
              if (attempt > retries) {
                return { i, exportIndex, ok: false, url, status: e?.status, error: String(e) };
              }
              await sleep(500 + attempt * 350);
            }
          }
          return { i, exportIndex, ok: false, url, error: "Stopped" };
        })());
      }

      const results = await Promise.all(batch);
      results.sort((a, b) => a.i - b.i);

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
      try { await temp.writable.abort(); } catch {}
      try { await temp.root.removeEntry(temp.tempName); } catch {}
      chrome.runtime.sendMessage({ type: "EXPORT_DONE", progress: withEstimates(progress) });
      return;
    }

    if (downloadMetadata) {
      await zip.addText("failures.json", JSON.stringify({ fetchedAt: new Date().toISOString(), failures }, null, 2));
    }

    await zip.finish();
    const zipFile = await temp.handle.getFile();
    // OPFS File objects have an empty MIME type. Brave may therefore save the
    // finished archive as a text file even though the filename ends in .zip.
    // Wrap the snapshot with the explicit ZIP MIME type before creating the
    // download URL. This does not rewrite the archive contents.
    const zipBlob = new Blob([zipFile], { type: "application/zip" });
    await downloadSingleFile(zipBlob, zipFilename);

    // The Blob references a snapshot of the OPFS file, so the temporary entry can be cleaned up.
    setTimeout(() => {
      temp.root.removeEntry(temp.tempName).catch(() => {});
    }, 60000);

    chrome.runtime.sendMessage({ type: "EXPORT_DONE", progress: withEstimates(progress) });
  } catch (e) {
    if (temp?.writable) {
      try { await temp.writable.abort(); } catch {}
    }
    if (temp?.root && temp?.tempName) {
      try { await temp.root.removeEntry(temp.tempName); } catch {}
    }
    throw e;
  }
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
