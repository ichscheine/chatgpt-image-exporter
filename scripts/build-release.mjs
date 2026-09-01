import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ZipStreamWriter } from "../zip-writer.mjs";

export const RUNTIME_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "injected.js",
  "export-range.mjs",
  "security.mjs",
  "offscreen.html",
  "offscreen.js",
  "opfs-temp.mjs",
  "zip-writer.mjs",
  "popup.html",
  "popup.js",
  "popup.css",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png"
];

class MemoryWritable {
  constructor() {
    this.parts = [];
  }

  async write(value) {
    if (value instanceof Blob) {
      this.parts.push(new Uint8Array(await value.arrayBuffer()));
      return;
    }
    this.parts.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }

  async close() {}

  toBuffer() {
    return Buffer.concat(this.parts.map((part) => Buffer.from(part)));
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

if (manifest.version !== packageJson.version) {
  throw new Error(`Version mismatch: manifest ${manifest.version}, package ${packageJson.version}`);
}

const writable = new MemoryWritable();
const zip = new ZipStreamWriter(writable);
for (const relativePath of RUNTIME_FILES) {
  const data = await fs.readFile(path.join(root, relativePath));
  await zip.addBlob(relativePath, new Blob([data]));
}
await zip.finish();

const dist = path.join(root, "dist");
const output = path.join(dist, `chatgpt-image-exporter-${manifest.version}.zip`);
await fs.mkdir(dist, { recursive: true });
await fs.writeFile(output, writable.toBuffer());

console.log(JSON.stringify({ output, version: manifest.version, files: RUNTIME_FILES.length }, null, 2));
