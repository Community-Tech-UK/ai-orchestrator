import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { interpolateCommandTemplate } from './command-interpolation';

describe('interpolateCommandTemplate', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-interp-'));
    await fs.writeFile(path.join(tmpDir, 'note.txt'), 'hello from file', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns the template unchanged when no dynamic tokens are present', async () => {
    const out = await interpolateCommandTemplate('plain $1 template', { cwd: tmpDir });
    expect(out).toBe('plain $1 template');
  });

  it('inlines @{file} contents relative to cwd', async () => {
    const out = await interpolateCommandTemplate('Context:\n@{note.txt}', { cwd: tmpDir });
    expect(out).toBe('Context:\nhello from file');
  });

  it('leaves @{file} untouched when the file does not exist', async () => {
    const out = await interpolateCommandTemplate('@{missing.txt}', { cwd: tmpDir });
    expect(out).toBe('@{missing.txt}');
  });

  it('replaces !`shell` with command stdout', async () => {
    const out = await interpolateCommandTemplate('result: !`echo orchestrated`', { cwd: tmpDir });
    expect(out).toBe('result: orchestrated');
  });

  it('handles multiple tokens in one template', async () => {
    const out = await interpolateCommandTemplate('!`echo a` / @{note.txt}', { cwd: tmpDir });
    expect(out).toBe('a / hello from file');
  });

  it('surfaces a bounded error marker when the shell command fails', async () => {
    const out = await interpolateCommandTemplate('!`exit 3`', { cwd: tmpDir });
    expect(out).toContain('[shell error');
  });
});
