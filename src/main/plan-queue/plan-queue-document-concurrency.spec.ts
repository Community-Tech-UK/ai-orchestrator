import * as disk from 'node:fs';
import * as fs from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { classifyFilename } from './plan-queue-discovery';
import { appendParkedNote, removeParkedNote, renameDocumentsInPlace } from './plan-queue-doc-close';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock('fs/promises', async original => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), unlink: vi.fn(actual.unlink) };
});
let root: string;
const initial = '# Plan\n- [x] Reviewed.\n';
const addition = '- [ ] Concurrent requirement.\n';
const note = { branchName: 'queue/fixture', reason: 'land-blocked', commitCount: 1 };
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const promises = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  vi.mocked(disk.renameSync).mockImplementation(actual.renameSync);
  vi.mocked(fs.readFile).mockImplementation(promises.readFile);
  root = disk.realpathSync(disk.mkdtempSync(join(tmpdir(), 'queue-doc-concurrent-')));
});
afterEach(() => { vi.restoreAllMocks(); disk.rmSync(root, { recursive: true, force: true }); });

it.each(['insert', 'remove'] as const)('preserves an edit after the asynchronous parked-note %s read', async mode => {
  const file = join(root, 'case_plan.md'); disk.writeFileSync(file, initial);
  if (mode === 'remove') await appendParkedNote(file, note);
  const before = disk.readFileSync(file, 'utf8');
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  let injected = false;
  vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await actual.readFile(...args);
    if (String(args[0]) === file && !injected) { injected = true; disk.appendFileSync(file, addition); }
    return bytes;
  });
  const change = await (mode === 'insert' ? appendParkedNote(file, note) : removeParkedNote(file, note.branchName)).catch(() => undefined);
  expect(injected).toBe(true);
  expect(disk.readFileSync(file, 'utf8')).toBe(before + addition);
  expect(change).toBeUndefined();
});

it.each(['leaf', 'ancestor'] as const)('refuses a parked-note %s symlink without changing its target', async kind => {
  const folder = join(root, 'docs'); disk.mkdirSync(folder);
  const file = join(folder, 'case_plan.md'); disk.writeFileSync(file, initial);
  const target = join(root, 'unrelated.md'); disk.writeFileSync(target, initial);
  if (kind === 'leaf') { disk.unlinkSync(file); disk.symlinkSync(target, file); }
  else { disk.renameSync(folder, folder + '-real'); disk.symlinkSync(folder + '-real', folder); }
  const result = await appendParkedNote(file, note).catch(() => undefined);
  expect(result).toBeUndefined();
  expect(disk.readFileSync(file, 'utf8')).toBe(initial);
  expect(disk.readFileSync(target, 'utf8')).toBe(initial);
});

it('preserves a late writer on the original inode after source retirement', async () => {
  const file = join(root, 'case_plan.md'); disk.writeFileSync(file, initial);
  const fd = disk.openSync(file, 'a');
  try {
    await renameDocumentsInPlace(file, null);
    disk.writeSync(fd, addition);
    const copies = disk.readdirSync(root).map(name => join(root, name)).filter(name => disk.lstatSync(name).isFile());
    const retained = copies.filter(name => name.includes('.aio-retained-'));
    expect(retained).toHaveLength(1);
    expect(classifyFilename(retained[0])).toBe('other');
    expect(disk.readFileSync(retained[0], 'utf8')).toBe(initial + addition);
    expect(existsActive(file)).toBe(false);
  } finally { disk.closeSync(fd); }
});
function existsActive(file: string): boolean { return disk.existsSync(file); }

it.each(['insert', 'remove', 'retire'] as const)('preserves a concurrent edit at the actual %s claim boundary', async mode => {
  const file = join(root, 'case_plan.md'); disk.writeFileSync(file, initial);
  if (mode === 'remove') await appendParkedNote(file, note);
  const before = disk.readFileSync(file, 'utf8');
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let injected = false;
  vi.mocked(disk.renameSync).mockImplementation((from, to) => {
    if (String(from) === file && !injected) { injected = true; disk.appendFileSync(file, addition); }
    return actual.renameSync(from, to);
  });
  const action = mode === 'retire' ? renameDocumentsInPlace(file, null)
    : mode === 'insert' ? appendParkedNote(file, note) : removeParkedNote(file, note.branchName);
  await expect(action).rejects.toThrow('retained');
  expect(injected).toBe(true);
  expect(disk.readFileSync(file, 'utf8')).toBe(before + addition);
});

it.each(['replacement', 'symlink'] as const)('preserves an unreviewed %s at source retirement', async kind => {
  const file = join(root, 'case_plan.md'); disk.writeFileSync(file, initial);
  const target = join(root, 'unrelated.md'); disk.writeFileSync(target, addition);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let injected = false;
  vi.mocked(disk.renameSync).mockImplementation((from, to) => {
    if (String(from) === file && !injected) {
      injected = true; actual.renameSync(file, join(root, 'original.md'));
      if (kind === 'symlink') disk.symlinkSync(target, file); else disk.writeFileSync(file, addition);
    }
    return actual.renameSync(from, to);
  });
  await expect(renameDocumentsInPlace(file, null)).rejects.toThrow('retained');
  expect(injected).toBe(true);
  expect(disk.readFileSync(file, 'utf8')).toBe(addition);
  expect(disk.readFileSync(target, 'utf8')).toBe(addition);
  expect(disk.lstatSync(file).isSymbolicLink()).toBe(kind === 'symlink');
  expect(disk.readFileSync(join(root, 'original.md'), 'utf8')).toBe(initial);
});

it('restores an unrelated file reached by a racing ancestor replacement without rewriting it', async () => {
  const folder = join(root, 'docs'); disk.mkdirSync(folder);
  const outside = join(root, 'unrelated'); disk.mkdirSync(outside);
  const file = join(folder, 'case_plan.md'); disk.writeFileSync(file, initial);
  const target = join(outside, 'case_plan.md'); disk.writeFileSync(target, addition);
  const targetInode = disk.statSync(target).ino;
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let injected = false;
  vi.mocked(disk.renameSync).mockImplementation((from, to) => {
    if (String(from) === file && !injected) {
      injected = true; actual.renameSync(folder, folder + '-original'); disk.symlinkSync(outside, folder);
    }
    return actual.renameSync(from, to);
  });
  await expect(appendParkedNote(file, note)).rejects.toThrow('retained');
  expect(injected).toBe(true);
  expect(disk.readFileSync(target, 'utf8')).toBe(addition);
  expect(disk.statSync(target).ino).toBe(targetInode);
  expect(disk.readFileSync(join(folder + '-original', 'case_plan.md'), 'utf8')).toBe(initial);
});
