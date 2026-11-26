import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAttachmentsIgnored } from './attachments-ignore';
import { processAttachments } from './file-handler';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'attachment-ignore-')); execFileSync('git', ['init', '-q'], { cwd: root }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('attachment local ignore', () => {
  it('adds one exclude line even for concurrent calls and nested working directories', async () => {
    const nested = join(root, 'nested'); await mkdir(nested);
    await Promise.all([ensureAttachmentsIgnored(nested), ensureAttachmentsIgnored(nested)]);
    const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8');
    expect(exclude.match(/^\.claude-attachments\/$/gm)).toHaveLength(1);
    await mkdir(join(nested, '.claude-attachments')); await writeFile(join(nested, '.claude-attachments/file.txt'), 'fixture');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
  });
  it('leaves a project with a tracked ignore rule unchanged', async () => {
    await writeFile(join(root, '.gitignore'), '.claude-attachments/\n');
    const before = await readFile(join(root, '.git/info/exclude'), 'utf8');
    await ensureAttachmentsIgnored(root);
    expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toBe(before);
  });
  it('does nothing in a non-git directory', async () => {
    const other = await mkdtemp(join(tmpdir(), 'attachment-nongit-'));
    try { await expect(ensureAttachmentsIgnored(other)).resolves.toBeUndefined(); }
    finally { await rm(other, { recursive: true, force: true }); }
  });
  it('retains attachment paths while hiding the created files from git', async () => {
    const result = await processAttachments([{ name: 'fixture.txt', type: 'text/plain', size: 7, data: Buffer.from('fixture').toString('base64') }], 'session', root);
    expect(result[0]?.filePath).toBe(join(root, '.claude-attachments/session/fixture.txt'));
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
  });
});
