export interface ZipEntryInput {
  name: string;
  content: Buffer | string;
}

interface PreparedZipEntry {
  name: string;
  nameBuffer: Buffer;
  content: Buffer;
  crc32: number;
  localHeaderOffset: number;
}

const CRC32_TABLE = buildCrc32Table();

export function createStoredZip(entries: ZipEntryInput[]): Buffer {
  const prepared: PreparedZipEntry[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry.name);
    const nameBuffer = Buffer.from(name, 'utf-8');
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf-8');
    const crc32 = computeCrc32(content);
    const localHeader = createLocalHeader(nameBuffer, content.length, crc32);

    prepared.push({
      name,
      nameBuffer,
      content,
      crc32,
      localHeaderOffset: offset,
    });
    localParts.push(localHeader, nameBuffer, content);
    offset += localHeader.length + nameBuffer.length + content.length;
  }

  const centralDirectoryOffset = offset;
  const centralParts: Buffer[] = [];
  for (const entry of prepared) {
    const header = createCentralDirectoryHeader(entry);
    centralParts.push(header, entry.nameBuffer);
    offset += header.length + entry.nameBuffer.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  const endRecord = createEndOfCentralDirectory(
    prepared.length,
    centralDirectorySize,
    centralDirectoryOffset,
  );

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

function normalizeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) {
    throw new Error(`Invalid zip entry name: ${name}`);
  }
  return normalized;
}

function createLocalHeader(
  nameBuffer: Buffer,
  contentLength: number,
  crc32: number,
): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc32, 14);
  header.writeUInt32LE(contentLength, 18);
  header.writeUInt32LE(contentLength, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function createCentralDirectoryHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.content.length, 20);
  header.writeUInt32LE(entry.content.length, 24);
  header.writeUInt16LE(entry.nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.localHeaderOffset, 42);
  return header;
}

function createEndOfCentralDirectory(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralDirectorySize, 12);
  record.writeUInt32LE(centralDirectoryOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function computeCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}
