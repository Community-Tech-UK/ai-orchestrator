import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendToRotatingLog, ROTATED_LOG_COPIES } from '../rotating-log-file';

describe('appendToRotatingLog', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rotating-log-'));
    file = path.join(dir, 'nested', 'trace.ndjson');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const read = (target: string) => fs.readFile(target, 'utf8');

  it('creates the folder and appends while under the cap', async () => {
    await expect(appendToRotatingLog(file, 'a\n', 10)).resolves.toBe(false);
    await expect(appendToRotatingLog(file, 'b\n', 10)).resolves.toBe(false);
    expect(await read(file)).toBe('a\nb\n');
  });

  it('rotates before an append that would pass the cap', async () => {
    await appendToRotatingLog(file, '12345\n', 10);
    await expect(appendToRotatingLog(file, '67890\n', 10)).resolves.toBe(true);
    expect(await read(file)).toBe('67890\n');
    expect(await read(`${file}.1`)).toBe('12345\n');
  });

  it(`keeps ${ROTATED_LOG_COPIES} older copies and drops the rest`, async () => {
    for (const line of ['one\n', 'two\n', 'three\n', 'four\n']) {
      await appendToRotatingLog(file, line, 5);
    }
    expect(await read(file)).toBe('four\n');
    expect(await read(`${file}.1`)).toBe('three\n');
    expect(await read(`${file}.2`)).toBe('two\n');
    await expect(fs.stat(`${file}.3`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rotates a file that already grew past the cap under older code', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'x'.repeat(100));
    await expect(appendToRotatingLog(file, 'new\n', 50)).resolves.toBe(true);
    expect(await read(file)).toBe('new\n');
    expect((await fs.stat(`${file}.1`)).size).toBe(100);
  });

  it('still writes a single append larger than the cap', async () => {
    await expect(appendToRotatingLog(file, 'x'.repeat(20), 10)).resolves.toBe(false);
    expect(await read(file)).toHaveLength(20);
  });
});
