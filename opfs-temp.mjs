export const TEMP_ZIP_PREFIX = "cgpt-image-exporter-temp-";

export async function cleanupStaleTempZipFiles(root) {
  let removed = 0;
  for await (const name of root.keys()) {
    if (name.startsWith(TEMP_ZIP_PREFIX) && name.endsWith(".zip.tmp")) {
      await root.removeEntry(name);
      removed++;
    }
  }
  return removed;
}

export async function createTempZipFile(storageManager = globalThis.navigator?.storage) {
  if (!storageManager?.getDirectory) {
    throw new Error("This Chromium build does not expose the local storage required for ZIP export.");
  }

  const root = await storageManager.getDirectory();
  await cleanupStaleTempZipFiles(root);
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempName = `${TEMP_ZIP_PREFIX}${id}.zip.tmp`;
  const handle = await root.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  return { root, handle, writable, tempName };
}
