import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupStaleTempZipFiles,
  createTempZipFile,
  TEMP_ZIP_PREFIX
} from "../opfs-temp.mjs";

function fakeRoot(initialNames = []) {
  const names = new Set(initialNames);
  const writable = { abort: async () => {}, close: async () => {}, write: async () => {} };
  return {
    names,
    async *keys() {
      yield* [...names];
    },
    async removeEntry(name) {
      names.delete(name);
    },
    async getFileHandle(name) {
      names.add(name);
      return {
        async createWritable() {
          return writable;
        }
      };
    }
  };
}

test("stale exporter ZIP files are removed without touching unrelated storage", async () => {
  const root = fakeRoot([
    `${TEMP_ZIP_PREFIX}old.zip.tmp`,
    "another-app.zip.tmp",
    `${TEMP_ZIP_PREFIX}not-a-zip.txt`
  ]);
  assert.equal(await cleanupStaleTempZipFiles(root), 1);
  assert.deepEqual([...root.names].sort(), [
    "another-app.zip.tmp",
    `${TEMP_ZIP_PREFIX}not-a-zip.txt`
  ].sort());
});

test("creating a temporary ZIP cleans stale entries and uses a scoped name", async () => {
  const root = fakeRoot([`${TEMP_ZIP_PREFIX}crashed.zip.tmp`]);
  const temp = await createTempZipFile({ getDirectory: async () => root });
  assert.equal(root.names.has(`${TEMP_ZIP_PREFIX}crashed.zip.tmp`), false);
  assert.equal(temp.tempName.startsWith(TEMP_ZIP_PREFIX), true);
  assert.equal(temp.tempName.endsWith(".zip.tmp"), true);
  assert.equal(root.names.has(temp.tempName), true);
});
