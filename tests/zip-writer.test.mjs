import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeZipBaseName, ZipStreamWriter } from "../zip-writer.mjs";

class MemoryWritable {
  constructor() {
    this.parts = [];
    this.closed = false;
  }

  async write(value) {
    if (value instanceof Blob) {
      this.parts.push(new Uint8Array(await value.arrayBuffer()));
    } else {
      this.parts.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  }

  async close() {
    this.closed = true;
  }

  bytes() {
    const size = this.parts.reduce((total, part) => total + part.byteLength, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of this.parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }
}

test("ZIP writer emits valid local, central, and end records", async () => {
  const writable = new MemoryWritable();
  const zip = new ZipStreamWriter(writable);
  await zip.addBlob("hello.txt", new Blob(["hello"]));
  await zip.addText("metadata.json", "{}");
  await zip.finish();

  const bytes = writable.bytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(writable.closed, true);
  assert.equal(view.getUint32(0, true), 0x04034B50);
  assert.equal(view.getUint32(14, true), 0x3610A686);
  assert.equal(new TextDecoder().decode(bytes.slice(30, 39)), "hello.txt");

  const eocdOffset = bytes.byteLength - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054B50);
  assert.equal(view.getUint16(eocdOffset + 10, true), 2);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014B50);
});

test("ZIP base names cannot create paths or unsafe platform names", () => {
  assert.equal(sanitizeZipBaseName(" ../My:Images. "), ".._My_Images");
  assert.equal(sanitizeZipBaseName("   "), "ChatGPT_Images");
});
