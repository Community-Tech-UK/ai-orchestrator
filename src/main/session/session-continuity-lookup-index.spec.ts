import * as fs from 'node:fs/promises';
import { promises as nodeFs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContinuityLookupIndex } from './session-continuity-lookup-index';
import type { SessionState } from './session-continuity.types';
import { waitForChangeClockTick } from '../testing/change-clock.test-helpers';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => logger }));

// Native ESM exports are immutable; route stat calls through the mutable Node
// promises object so these tests exercise failures in the actual filesystem API.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  lstat: (...args: Parameters<typeof nodeFs.lstat>) => nodeFs.lstat(...args),
}));

describe('continuity identifier index', () => {
  let dir: string;
  const indexes: SessionContinuityLookupIndex[] = [];
  const state = (instanceId: string, historyThreadId?: string): SessionState => ({
    instanceId, historyThreadId, sessionId: `native-${instanceId}`,
    displayName: 'Fixture', agentId: 'build', modelId: 'EXAMPLE_MODEL', workingDirectory: '/fixture',
    conversationHistory: [], contextUsage: { used: 0, total: 1000 }, pendingTasks: [],
    environmentVariables: {}, activeFiles: [], skillsLoaded: [], hooksActive: [],
  });
  const create = (read = vi.fn(async (file: string): Promise<SessionState | null> => JSON.parse(await fs.readFile(file, 'utf8')) as SessionState), canBackfill = () => true, now = Date.now) => {
    const index = new SessionContinuityLookupIndex({
      stateDir: path.join(dir, 'states'), metadataDir: path.join(dir, 'metadata'),
      indexPath: path.join(dir, 'lookup-index.json'), readState: read, canBackfill, now,
    });
    indexes.push(index);
    return { index, read };
  };
  const write = async (value: SessionState) => {
    await fs.writeFile(path.join(dir, 'states', `${value.instanceId}.json`), JSON.stringify(value));
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-index-'));
    await fs.mkdir(path.join(dir, 'states'));
    await fs.mkdir(path.join(dir, 'metadata'));
  });
  afterEach(async () => {
    await Promise.all(indexes.splice(0).map((index) => index.close()));
    await fs.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('backfills aliases once and resolves complete misses without reading any state', async () => {
    await write(state('one', 'history-one'));
    await write(state('two', 'history-two'));
    const { index, read } = create();
    await index.backfill();
    expect(index.isComplete()).toBe(true);
    read.mockClear();
    expect(await index.find('history-two')).toMatchObject({ instanceId: 'two' });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    expect(await index.find('absent')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('reports complete-miss metadata checks and includes their elapsed time', async () => {
    await write(state('one'));
    await write(state('two'));
    let now = 0;
    const { index, read } = create(undefined, () => true, () => now);
    await index.backfill();
    const lstat = nodeFs.lstat.bind(nodeFs);
    vi.spyOn(nodeFs, 'lstat').mockImplementation(async (...args: Parameters<typeof nodeFs.lstat>) => {
      now += 7;
      return lstat(...args);
    });
    logger.info.mockClear();

    expect(await index.find('absent')).toBeNull();

    expect(read).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Identifier lookup scanned state files', {
      scanned: 0, fileStats: 3, directoryReads: 1, ms: 21, found: false,
    });
  });

  it('reports metadata work before fallback scans and on negative-cache hits', async () => {
    await write(state('one'));
    await write(state('two'));
    let now = 0;
    const read = vi.fn(async (file: string): Promise<SessionState> => {
      now += 11;
      return JSON.parse(await fs.readFile(file, 'utf8')) as SessionState;
    });
    const { index } = create(read, () => false, () => now);
    const lstat = nodeFs.lstat.bind(nodeFs);
    vi.spyOn(nodeFs, 'lstat').mockImplementation(async (...args: Parameters<typeof nodeFs.lstat>) => {
      now += 7;
      return lstat(...args);
    });

    expect(await index.find('absent')).toBeNull();
    expect(logger.info).toHaveBeenLastCalledWith('Identifier lookup scanned state files', {
      scanned: 2, fileStats: 5, directoryReads: 2, ms: 57, found: false,
    });
    read.mockClear();
    expect(await index.find('absent')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenLastCalledWith('Identifier lookup scanned state files', {
      scanned: 0, fileStats: 1, directoryReads: 0, ms: 7, found: false,
    });
  });

  it('reloads the atomic index without rereading unchanged transcript files', async () => {
    await write(state('one', 'history-one'));
    const first = create();
    await first.index.backfill();
    await first.index.flush();
    const reads = vi.spyOn(nodeFs, 'readFile');
    const second = create();
    await second.index.backfill();
    expect(second.index.get('history-one')).toBe('one.json');
    expect(reads.mock.calls.filter(([file]) => String(file).startsWith(path.join(dir, 'states')))).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'lookup-index.json'), 'utf8')).version).toBe(1);
  });

  it('uses bound recovery metadata instead of opening a large transcript', async () => {
    await write(state('one', 'history-one'));
    const stat = await fs.stat(path.join(dir, 'states', 'one.json'));
    await fs.writeFile(path.join(dir, 'metadata', 'one.json'), JSON.stringify({
      sourceInstanceId: 'one', historyThreadId: 'history-one', sessionId: 'native-one',
      stateFileGeneration: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino },
    }));
    const reads = vi.spyOn(nodeFs, 'readFile');
    const { index } = create();
    await index.backfill();
    expect(index.get('history-one')).toBe('one.json');
    expect(reads.mock.calls.filter(([file]) => String(file).startsWith(path.join(dir, 'states')))).toEqual([]);
  });

  it('falls back while paused/incomplete and caches repeated misses for ten minutes', async () => {
    let now = 0;
    await write(state('one', 'history-one'));
    const { index, read } = create(undefined, () => false, () => now);
    expect(await index.find('history-one')).toMatchObject({ instanceId: 'one' });
    expect(await index.find('absent')).toBeNull();
    const calls = read.mock.calls.length;
    expect(await index.find('absent')).toBeNull();
    expect(read.mock.calls.length).toBe(calls);
    now = 600_001;
    await index.find('absent');
    expect(read.mock.calls.length).toBeGreaterThan(calls);
  });

  it('does not negative-cache a fallback miss after a transient unreadable state', async () => {
    await write(state('one', 'history-one'));
    let fail = true;
    const read = vi.fn(async (file: string): Promise<SessionState | null> => {
      if (fail) { fail = false; return null; }
      return JSON.parse(await fs.readFile(file, 'utf8')) as SessionState;
    });
    const { index } = create(read, () => false);
    expect(await index.find('history-one')).toBeNull();
    expect(await index.find('history-one')).toMatchObject({ instanceId: 'one' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('invalidates old aliases on upsert and finds a newly saved state without a scan', async () => {
    const value = state('one', 'old-history');
    await write(value);
    const { index, read } = create();
    await index.backfill();
    const updated = { ...value, historyThreadId: 'new-history' };
    await write(updated);
    await index.upsert(updated);
    read.mockClear();
    expect(await index.find('old-history')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(await index.find('new-history')).toMatchObject(updated);
    expect(read).toHaveBeenCalledTimes(1);
    await fs.unlink(path.join(dir, 'states', 'one.json'));
    index.remove('one');
    expect(index.get('new-history')).toBeUndefined();
  });

  it('does not trust stale entries or a persisted path outside the state directory', async () => {
    await write(state('one', 'old-history'));
    const first = create();
    await first.index.backfill();
    await first.index.flush();
    await write(state('one', 'new-history'));
    const second = create();
    await second.index.backfill();
    expect(await second.index.find('old-history')).toBeNull();
    expect(await second.index.find('new-history')).toMatchObject({ instanceId: 'one' });
    await fs.writeFile(path.join(dir, 'lookup-index.json'), JSON.stringify({
      version: 1, entries: [{ file: '../outside.json', keys: ['outside'] }],
    }));
    const third = create();
    await third.index.backfill();
    expect(third.index.get('outside')).toBeUndefined();
  });

  it('keeps corrupt identifiers unresolved while indexing healthy records', async () => {
    await fs.writeFile(path.join(dir, 'states', 'broken.json'), JSON.stringify({ instanceId: 12, historyThreadId: [] }));
    await write(state('one', 'history-one'));
    const { index } = create();
    await index.backfill();
    expect(index.isComplete()).toBe(false);
    expect(index.get('history-one')).toBe('one.json');
  });

  it.each(['EIO', 'EACCES'])('retries a transient %s instead of persisting an authoritative missing alias', async (code) => {
    await write(state('one', 'history-one'));
    const readFile = nodeFs.readFile.bind(nodeFs);
    let fail = true;
    vi.spyOn(nodeFs, 'readFile').mockImplementation((...args: Parameters<typeof nodeFs.readFile>) => {
      if (String(args[0]) === path.join(dir, 'states', 'one.json') && fail) {
        fail = false;
        return Promise.reject(Object.assign(new Error('EXAMPLE_READ_FAILURE'), { code }));
      }
      return readFile(...args);
    });
    const { index } = create();
    await index.backfill();
    expect(index.isComplete()).toBe(false);
    await index.flush();
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'lookup-index.json'), 'utf8'));
    expect(saved.entries).toEqual([]);
    expect(await index.find('history-one')).toMatchObject({ instanceId: 'one' });
    await index.backfill();
    expect(index.isComplete()).toBe(true);
    await index.flush();
    const reloaded = create();
    await reloaded.index.backfill();
    expect(await reloaded.index.find('history-one')).toMatchObject({ instanceId: 'one' });
  });

  it('backs off unchanged unresolved records and retries a new generation immediately', async () => {
    const file = path.join(dir, 'states', 'broken.json');
    await fs.writeFile(file, JSON.stringify({ instanceId: 12 }));
    let now = 0;
    const reads = vi.spyOn(nodeFs, 'readFile');
    const count = () => reads.mock.calls.filter(([name]) => String(name) === file).length;
    const { index } = create(undefined, () => true, () => now);
    await index.backfill();
    expect(count()).toBe(1);
    now = 1000;
    await index.backfill();
    now = 2000;
    await index.backfill();
    expect(count()).toBe(1);
    expect(index.isComplete()).toBe(false);
    now = 30_001;
    await index.backfill();
    expect(count()).toBe(2);
    await fs.writeFile(file, JSON.stringify(state('broken', 'repaired-history')));
    await index.backfill();
    expect(count()).toBe(3);
    expect(index.isComplete()).toBe(true);
    expect(index.get('repaired-history')).toBe('broken.json');
  });

  it.each(['EIO', 'EACCES'])('does not cache absence after metadata enumeration %s on an existing state', async (code) => {
    await write(state('one', 'history-one'));
    const file = path.join(dir, 'states', 'one.json');
    const lstat = nodeFs.lstat.bind(nodeFs);
    let fail = true;
    vi.spyOn(nodeFs, 'lstat').mockImplementation(async (...args: Parameters<typeof nodeFs.lstat>) => {
      if (String(args[0]) === file && fail) throw Object.assign(new Error('EXAMPLE_STAT_FAILURE'), { code });
      return lstat(...args);
    });
    const { index } = create(undefined, () => false);
    expect(await index.find('history-one').catch((error: NodeJS.ErrnoException) => {
      expect(error.code).toBe(code); return null;
    })).toBeNull();
    fail = false;
    expect(await index.find('history-one')).toMatchObject({ instanceId: 'one' });
  });

  it('backs off final generation-validation stat failures before rereading a transcript', async () => {
    await write(state('one', 'history-one'));
    const file = path.join(dir, 'states', 'one.json');
    const readFile = nodeFs.readFile.bind(nodeFs);
    const lstat = nodeFs.lstat.bind(nodeFs);
    let failNextStat = false;
    let stateReads = 0;
    let now = 0;
    vi.spyOn(nodeFs, 'readFile').mockImplementation(async (...args: Parameters<typeof nodeFs.readFile>) => {
      const result = await readFile(...args);
      if (String(args[0]) === file) { stateReads++; failNextStat = true; }
      return result;
    });
    const statSpy = vi.spyOn(nodeFs, 'lstat').mockImplementation(async (...args: Parameters<typeof nodeFs.lstat>) => {
      if (String(args[0]) === file && failNextStat) {
        failNextStat = false;
        throw Object.assign(new Error('EXAMPLE_VALIDATION_STAT_FAILURE'), { code: 'EIO' });
      }
      return lstat(...args);
    });
    const { index } = create(undefined, () => true, () => now);
    await index.backfill();
    await index.backfill();
    await index.backfill();
    expect(stateReads).toBe(1);
    expect(index.isComplete()).toBe(false);
    now = 30_001;
    await index.backfill();
    expect(stateReads).toBe(2);
    statSpy.mockRestore();
    await fs.writeFile(file, JSON.stringify(state('one', 'repaired-history')));
    await index.backfill();
    expect(index.isComplete()).toBe(true);
    expect(index.get('repaired-history')).toBe('one.json');
  });

  it('refreshes aliases after an in-place external edit without a directory rename', async () => {
    await write(state('one', 'old-history'));
    const { index } = create();
    await index.backfill();
    waitForChangeClockTick(); // same size, so only the change time can show the edit
    await fs.writeFile(path.join(dir, 'states', 'one.json'), JSON.stringify(state('one', 'new-history')));
    expect(await index.find('new-history')).toMatchObject({ instanceId: 'one' });
  });

  it('pauses backfill without reading a transcript while a loop is active', async () => {
    await write(state('one', 'history-one'));
    const reads = vi.spyOn(nodeFs, 'readFile');
    const { index } = create(undefined, () => false);
    await index.backfill();
    expect(index.isComplete()).toBe(false);
    expect(index.get('history-one')).toBeUndefined();
    expect(reads.mock.calls.filter(([file]) => String(file).startsWith(path.join(dir, 'states')))).toEqual([]);
  });

  it('notices a file added outside Harness and does not turn it into a permanent miss', async () => {
    const { index } = create();
    await index.backfill();
    expect(await index.find('new-history')).toBeNull();
    await write(state('new', 'new-history'));
    expect(await index.find('new-history')).toMatchObject({ instanceId: 'new' });
  });
});
