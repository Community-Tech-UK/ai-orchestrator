import { describe, expect, it } from 'vitest';
import { createStoredZip } from '../zip-writer';

describe('createStoredZip', () => {
  it('writes a valid stored zip central directory', () => {
    const zip = createStoredZip([
      { name: 'a.txt', content: 'alpha' },
      { name: 'nested/b.txt', content: Buffer.from('beta') },
    ]);

    expect(zip.readUInt32LE(0)).toBe(0x04034b50);

    const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocdOffset).toBeGreaterThan(0);
    const entryCount = zip.readUInt16LE(eocdOffset + 10);
    const centralSize = zip.readUInt32LE(eocdOffset + 12);
    const centralOffset = zip.readUInt32LE(eocdOffset + 16);

    expect(entryCount).toBe(2);
    expect(centralSize).toBeGreaterThan(0);
    expect(centralOffset).toBeGreaterThan(0);
    expect(zip.readUInt32LE(centralOffset)).toBe(0x02014b50);
  });

  it('rejects unsafe entry names', () => {
    expect(() => createStoredZip([{ name: '../escape.txt', content: 'x' }])).toThrow(
      /Invalid zip entry name/,
    );
  });
});
