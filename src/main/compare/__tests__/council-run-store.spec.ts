import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CouncilRunStore } from '../council-run-store';
import type { CouncilRun } from '@contracts/schemas/command';

function makeRun(overrides: Partial<CouncilRun> = {}): CouncilRun {
  return {
    id: `council-${Math.random().toString(36).slice(2)}`,
    prompt: 'test prompt',
    createdAt: Date.now(),
    members: [{ provider: 'claude', status: 'succeeded', answer: 'hi', durationMs: 10 }],
    cancelled: false,
    ...overrides,
  };
}

describe('CouncilRunStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-run-store-'));
    filePath = path.join(tmpDir, 'council-runs.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty list when no file exists yet', () => {
    const store = new CouncilRunStore(filePath);
    expect(store.loadAll()).toEqual([]);
    expect(store.getLatest()).toBeNull();
  });

  it('round-trips a saved run through a real file', () => {
    const store = new CouncilRunStore(filePath);
    const run = makeRun();
    store.saveRun(run);

    const reloaded = new CouncilRunStore(filePath);
    expect(reloaded.getRun(run.id)).toEqual(run);
    expect(reloaded.loadAll()).toEqual([run]);
  });

  it('upserts an existing run instead of duplicating it', () => {
    const store = new CouncilRunStore(filePath);
    const run = makeRun();
    store.saveRun(run);
    const updated = { ...run, cancelled: true };
    store.saveRun(updated);

    expect(store.loadAll()).toHaveLength(1);
    expect(store.getRun(run.id)?.cancelled).toBe(true);
  });

  it('newest run is first and is returned by getLatest', () => {
    const store = new CouncilRunStore(filePath);
    const older = makeRun({ id: 'older', createdAt: 1000 });
    const newer = makeRun({ id: 'newer', createdAt: 2000 });
    store.saveRun(older);
    store.saveRun(newer);

    expect(store.getLatest()?.id).toBe('newer');
  });

  it('caps the number of retained runs, dropping the oldest', () => {
    const store = new CouncilRunStore(filePath);
    for (let i = 0; i < 25; i++) {
      store.saveRun(makeRun({ id: `run-${i}`, createdAt: i }));
    }
    const all = store.loadAll();
    expect(all.length).toBeLessThanOrEqual(20);
    // Most recently saved run must survive the cap.
    expect(store.getRun('run-24')).not.toBeNull();
  });

  it('degrades gracefully (no throw) when the file contains invalid JSON', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(filePath, 'not json', 'utf8');
    const store = new CouncilRunStore(filePath);
    expect(store.loadAll()).toEqual([]);
  });

  it('is a no-op (never throws) when constructed with an empty path (no Electron userData)', () => {
    const store = new CouncilRunStore('');
    expect(() => store.saveRun(makeRun())).not.toThrow();
    expect(store.loadAll()).toEqual([]);
    expect(store.getLatest()).toBeNull();
  });
});
