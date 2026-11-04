import * as disk from 'node:fs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dietAtCheckpoint, maybeDietDocument } from './plan-queue-plan-diet';
import { newPlanQueueItem } from './plan-queue-state';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync), linkSync: vi.fn(actual.linkSync) };
});

const content = '# Plan\n## Status\nActive\n## Status\nActive\n## As-built\n### 3 November\nKeep this journal.\n## Final verification\nKeep this too.\n';
let root: string;
let folder: string;
let documentPath: string;
let historyPath: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(disk.writeFileSync).mockImplementation(actual.writeFileSync);
  vi.mocked(disk.linkSync).mockImplementation(actual.linkSync);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-diet-identity-')));
  folder = join(root, 'plans'); mkdirSync(folder);
  documentPath = join(folder, 'fixture_plan.md'); historyPath = join(folder, 'fixture_history.md');
  writeFileSync(documentPath, content); writeFileSync(historyPath, 'Earlier evidence\n');
});
afterEach(() => { vi.mocked(openSync).mockRestore(); rmSync(root, { recursive: true, force: true }); });

describe('checkpoint root document and history identity', () => {
  it.each(['history', 'document', 'ancestor'] as const)('refuses a pre-existing %s symlink through the production checkpoint wrapper', async target => {
    const outside = join(root, 'unrelated.md'); writeFileSync(outside, target === 'document' ? content : 'Unrelated bytes\n');
    if (target === 'ancestor') {
      renameSync(folder, join(root, 'original-plans'));
      symlinkSync(join(root, 'original-plans'), folder, 'dir');
    } else {
      const file = target === 'history' ? historyPath : documentPath;
      unlinkSync(file); symlinkSync(outside, file);
    }
    const before = [readFileSync(documentPath), readFileSync(historyPath), readFileSync(outside)];
    await dietAtCheckpoint(newPlanQueueItem('item', 'run', documentPath, 1));
    expect([readFileSync(documentPath), readFileSync(historyPath), readFileSync(outside)]).toEqual(before);
    expect(lstatSync(target === 'ancestor' ? folder : target === 'history' ? historyPath : documentPath).isSymbolicLink()).toBe(true);
  });

  it.each(['history', 'document', 'ancestor', 'ancestor-link', 'new-history-link'] as const)(
    'preserves both inputs when %s identity changes with identical bytes during preparation', async target => {
      if (target === 'new-history-link') unlinkSync(historyPath);
      const outside = join(root, 'unrelated.md'); writeFileSync(outside, 'Unrelated bytes\n');
      const result = await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0, onMovePrepared: () => {
        if (target === 'ancestor' || target === 'ancestor-link') {
          renameSync(folder, join(root, 'original-plans'));
          if (target === 'ancestor-link') symlinkSync(join(root, 'original-plans'), folder, 'dir');
          else { mkdirSync(folder); writeFileSync(documentPath, content); writeFileSync(historyPath, 'Earlier evidence\n'); }
        } else if (target === 'new-history-link') symlinkSync(outside, historyPath);
        else {
          const file = target === 'history' ? historyPath : documentPath;
          renameSync(file, `${file}.original`); writeFileSync(file, target === 'history' ? 'Earlier evidence\n' : content);
        }
      } });
      expect(result.moved).toBe(false);
      expect(readFileSync(documentPath, 'utf8')).toBe(content);
      expect(readFileSync(historyPath, 'utf8')).toBe(target === 'new-history-link' ? 'Unrelated bytes\n' : 'Earlier evidence\n');
      expect(readFileSync(outside, 'utf8')).toBe('Unrelated bytes\n');
      if (existsSync(join(root, 'original-plans'))) {
        expect(readFileSync(join(root, 'original-plans', 'fixture_plan.md'), 'utf8')).toBe(content);
        expect(readFileSync(join(root, 'original-plans', 'fixture_history.md'), 'utf8')).toBe('Earlier evidence\n');
      }
    },
  );

  it('preserves a concurrent history edit and the original document', async () => {
    const result = await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0,
      onMovePrepared: () => writeFileSync(historyPath, 'Concurrent evidence\n') });
    expect(result.moved).toBe(false);
    expect(readFileSync(documentPath, 'utf8')).toBe(content);
    expect(readFileSync(historyPath, 'utf8')).toBe('Concurrent evidence\n');
  });

  it.each(['history-link', 'ancestor', 'document-edit'] as const)('rechecks %s after opening handles at the write boundary', async target => {
    const outside = join(root, 'unrelated.md'); writeFileSync(outside, 'Unrelated bytes\n');
    const realOpen = vi.mocked(openSync).getMockImplementation();
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      const fd = realOpen!(file, flags, mode);
      if (file === historyPath) {
        if (target === 'history-link') { renameSync(historyPath, `${historyPath}.original`); symlinkSync(outside, historyPath); }
        else if (target === 'ancestor') {
          renameSync(folder, join(root, 'original-plans')); mkdirSync(folder);
          writeFileSync(documentPath, content); writeFileSync(historyPath, 'Earlier evidence\n');
        } else writeFileSync(documentPath, 'Concurrent document edit\n');
      }
      return fd;
    });
    expect(await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 })).toMatchObject({ moved: false });
    expect(readFileSync(documentPath, 'utf8')).toBe(target === 'document-edit' ? 'Concurrent document edit\n' : content);
    expect(readFileSync(historyPath, 'utf8')).toBe(target === 'history-link' ? 'Unrelated bytes\n' : 'Earlier evidence\n');
    expect(readFileSync(outside, 'utf8')).toBe('Unrelated bytes\n');
    if (target === 'history-link') expect(readFileSync(`${historyPath}.original`, 'utf8')).toBe('Earlier evidence\n');
    if (target === 'ancestor') {
      expect(readFileSync(join(root, 'original-plans', 'fixture_plan.md'), 'utf8')).toBe(content);
      expect(readFileSync(join(root, 'original-plans', 'fixture_history.md'), 'utf8')).toBe('Earlier evidence\n');
    }
  });

  it.each(['original descriptor', 'active path'] as const)('preserves concurrent history evidence from the %s at final publication', async writer => {
    const addition = 'Concurrent history evidence.\n';
    const before = readFileSync(historyPath);
    const fd = disk.openSync(historyPath, 'a');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let injected = false;
    const append = () => {
      if (injected) return;
      injected = true;
      if (writer === 'original descriptor') disk.writeSync(fd, addition);
      else disk.appendFileSync(historyPath, addition);
    };
    vi.mocked(disk.writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file === 'number' && existsSync(historyPath)
        && disk.fstatSync(file).ino === disk.statSync(historyPath).ino) append();
      return actual.writeFileSync(file, data, options);
    });
    vi.mocked(disk.linkSync).mockImplementation((from, to) => {
      actual.linkSync(from, to);
      if (String(to) === historyPath) append();
    });
    try {
      await expect(maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 })).rejects.toThrow('original is retained');
      expect(injected).toBe(true);
      expect(readFileSync(documentPath, 'utf8')).toBe(content);
      const files = disk.readdirSync(folder).map(name => join(folder, name));
      expect(files.some(file => readFileSync(file).includes(Buffer.from(addition)))).toBe(true);
      if (writer === 'original descriptor') expect(files.some(file => readFileSync(file).equals(Buffer.concat([before, Buffer.from(addition)])))).toBe(true);
      else expect(readFileSync(historyPath, 'utf8')).toContain(addition);
    } finally { disk.closeSync(fd); }
  });

  it.each(['document', 'history'] as const)('preserves a racing %s symlink at exclusive publication', async target => {
    const file = target === 'document' ? documentPath : historyPath;
    const before = readFileSync(file);
    const outside = join(root, 'unrelated.md'); writeFileSync(outside, 'Unrelated bytes\n');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let injected = false;
    vi.mocked(disk.linkSync).mockImplementation((from, to) => {
      if (String(to) === file && !injected) { injected = true; symlinkSync(outside, file); }
      return actual.linkSync(from, to);
    });
    await expect(maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 })).rejects.toThrow('original is retained');
    expect(injected).toBe(true);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('Unrelated bytes\n');
    const retained = disk.readdirSync(folder).filter(name => name.startsWith(`.${target === 'document' ? 'fixture_plan.md' : 'fixture_history.md'}.aio-retained-`));
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(folder, retained[0]))).toEqual(before);
  });

  it('preserves arbitrary history bytes and late original-descriptor appends after a successful move', async () => {
    const before = Buffer.from([0xff, 0xfe, 0x0a]); writeFileSync(historyPath, before);
    const documentFd = disk.openSync(documentPath, 'a'); const historyFd = disk.openSync(historyPath, 'a');
    try {
      expect(await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 })).toMatchObject({ moved: true });
      expect(readFileSync(historyPath)).toEqual(Buffer.concat([before, Buffer.from('### 3 November\nKeep this journal.\n')]));
      disk.writeSync(documentFd, 'Late requirement\n'); disk.writeSync(historyFd, 'Late history\n');
      const copies = disk.readdirSync(folder).filter(name => name.includes('.aio-retained-')).map(name => readFileSync(join(folder, name)));
      expect(copies).toHaveLength(2);
      expect(copies.some(bytes => bytes.equals(Buffer.from(content + 'Late requirement\n')))).toBe(true);
      expect(copies.some(bytes => bytes.equals(Buffer.concat([before, Buffer.from('Late history\n')])))).toBe(true);
    } finally { disk.closeSync(documentFd); disk.closeSync(historyFd); }
  });

  it('accumulates successive journals without changing earlier history bytes', async () => {
    const first = await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 });
    expect(first.moved).toBe(true);
    const firstHistory = readFileSync(historyPath);
    writeFileSync(documentPath, content.replace('Keep this journal.', 'Second journal.'));
    expect(await maybeDietDocument({ documentPath, historyPath, bytesAtJobStart: 0 })).toMatchObject({ moved: true });
    expect(readFileSync(historyPath)).toEqual(Buffer.concat([firstHistory, Buffer.from('### 3 November\nSecond journal.\n')]));
    expect(disk.readdirSync(folder).filter(name => name.includes('.aio-retained-'))).toHaveLength(4);
  });

  it('moves journal bytes through the production wrapper when both files are regular and unchanged', async () => {
    await dietAtCheckpoint(newPlanQueueItem('item', 'run', documentPath, 1));
    expect(readFileSync(historyPath, 'utf8')).toBe('Earlier evidence\n### 3 November\nKeep this journal.\n');
    expect(readFileSync(documentPath, 'utf8')).toContain('## Final verification\nKeep this too.\n');
    expect(readFileSync(documentPath, 'utf8')).not.toContain('Keep this journal.');
  });
});
