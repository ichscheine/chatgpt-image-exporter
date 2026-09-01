function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crc32Table();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const dosTime = ((date.getHours() & 0x1F) << 11) |
                  ((date.getMinutes() & 0x3F) << 5) |
                  ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) |
                  (((date.getMonth() + 1) & 0x0F) << 5) |
                  (date.getDate() & 0x1F);
  return { dosTime, dosDate };
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

export function sanitizeZipBaseName(value) {
  const cleaned = String(value || "ChatGPT_Images")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "");
  return cleaned || "ChatGPT_Images";
}

export class ZipStreamWriter {
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
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
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
    this.entries.push({ nameBytes, crc, size, localOffset, dosTime, dosDate, needsZip64Size });
  }

  async addText(name, text) {
    await this.addBlob(name, new Blob([text], { type: "application/json" }));
  }

  async finish() {
    const centralOffset = this.offset;
    let centralSize = 0;

    for (const entry of this.entries) {
      const needsZip64Offset = entry.localOffset >= 0xFFFFFFFF;
      const extra = zip64Extra({
        uncompressedSize: entry.size,
        compressedSize: entry.size,
        localHeaderOffset: entry.localOffset
      }, entry.needsZip64Size, needsZip64Offset);
      const header = new Uint8Array(46 + entry.nameBytes.length + extra.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x02014B50, true);
      view.setUint16(4, 45, true);
      view.setUint16(6, (entry.needsZip64Size || needsZip64Offset) ? 45 : 20, true);
      view.setUint16(8, 0x0800, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, entry.dosTime, true);
      view.setUint16(14, entry.dosDate, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.needsZip64Size ? 0xFFFFFFFF : entry.size, true);
      view.setUint32(24, entry.needsZip64Size ? 0xFFFFFFFF : entry.size, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, extra.length, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, needsZip64Offset ? 0xFFFFFFFF : entry.localOffset, true);
      header.set(entry.nameBytes, 46);
      header.set(extra, 46 + entry.nameBytes.length);
      await this.write(header);
      centralSize += header.byteLength;
    }

    const entryCount = this.entries.length;
    const needsZip64 = entryCount >= 0xFFFF || centralOffset >= 0xFFFFFFFF || centralSize >= 0xFFFFFFFF;
    if (needsZip64) {
      const zip64EocdOffset = this.offset;
      const zip64 = new Uint8Array(56);
      const view = new DataView(zip64.buffer);
      view.setUint32(0, 0x06064B50, true);
      view.setBigUint64(4, 44n, true);
      view.setUint16(12, 45, true);
      view.setUint16(14, 45, true);
      view.setUint32(16, 0, true);
      view.setUint32(20, 0, true);
      view.setBigUint64(24, BigInt(entryCount), true);
      view.setBigUint64(32, BigInt(entryCount), true);
      view.setBigUint64(40, BigInt(centralSize), true);
      view.setBigUint64(48, BigInt(centralOffset), true);
      await this.write(zip64);

      const locator = new Uint8Array(20);
      const locatorView = new DataView(locator.buffer);
      locatorView.setUint32(0, 0x07064B50, true);
      locatorView.setUint32(4, 0, true);
      locatorView.setBigUint64(8, BigInt(zip64EocdOffset), true);
      locatorView.setUint32(16, 1, true);
      await this.write(locator);
    }

    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    view.setUint32(0, 0x06054B50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, needsZip64 ? 0xFFFF : entryCount, true);
    view.setUint16(10, needsZip64 ? 0xFFFF : entryCount, true);
    view.setUint32(12, needsZip64 ? 0xFFFFFFFF : centralSize, true);
    view.setUint32(16, needsZip64 ? 0xFFFFFFFF : centralOffset, true);
    view.setUint16(20, 0, true);
    await this.write(eocd);
    await this.writable.close();
  }
}
