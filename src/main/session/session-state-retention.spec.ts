import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listSessionStateCandidates, removeSessionStateCandidates } from './session-state-retention';
import { listSessionActivityLogCandidates, removeSessionActivityLogCandidates } from './session-activity-log-retention';

describe('old session file retention', () => {
  let root: string;
  const now = Date.now();
  const old = new Date(now - 31 * 86_400_000);
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-retention-'))); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function file(relative: string, aged = true) {
    const path = join(root, relative);
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, 'fixture');
    if (aged) await fs.utimes(path, old, old);
    return path;
  }
  it('removes only old non-live records and their metadata, leaving snapshots and quarantine', async () => {
    const stateDir = join(root, 'states');
    const metadataDir = join(root, 'recovery-metadata');
    const removed = await file('states/old.json');
    const metadata = await file('recovery-metadata/old.json');
    const kept = await Promise.all([file('states/live.json'), file('states/recent.json', false), file('snapshots/old.json'), file('quarantine/old.json')]);
    const candidates = await listSessionStateCandidates(stateDir, metadataDir, new Set(['live']), now);
    expect(candidates.map(item => item.path).sort()).toEqual([removed, metadata].sort());
    await removeSessionStateCandidates(candidates, stateDir, metadataDir, () => new Set(['live']), now);
    for (const path of kept) await expect(fs.access(path)).resolves.toBeUndefined();
    await expect(fs.access(removed)).rejects.toThrow();
    await expect(fs.access(metadata)).rejects.toThrow();
  });
  it('never follows symlinked files or directories outside the supplied roots', async () => {
    const external = await file('outside/private.json');
    await fs.mkdir(join(root, 'states'));
    await fs.symlink(external, join(root, 'states/escape.json'));
    await fs.mkdir(join(root, 'projects'));
    await fs.symlink(join(root, 'outside'), join(root, 'projects/escape'));
    expect(await listSessionStateCandidates(join(root, 'states'), join(root, 'metadata'), new Set(), now)).toEqual([]);
    expect(await listSessionActivityLogCandidates(join(root, 'projects'), new Set(), now)).toEqual([]);
    await expect(fs.access(external)).resolves.toBeUndefined();
  });
  it('keeps live and recent activity logs and ignores unrelated project files', async () => {
    const oldPath = await file('projects/fixture/session-events/old.jsonl');
    const kept = await Promise.all([file('projects/fixture/session-events/live.jsonl'), file('projects/fixture/session-events/recent.jsonl', false), file('projects/fixture/checkpoints/old.jsonl')]);
    const candidates = await listSessionActivityLogCandidates(join(root, 'projects'), new Set(['live']), now);
    expect(candidates.map(item => item.path)).toEqual([oldPath]);
    await removeSessionActivityLogCandidates(candidates, join(root, 'projects'), () => new Set(['live']), now);
    await expect(fs.access(oldPath)).rejects.toThrow();
    for (const path of kept) await expect(fs.access(path)).resolves.toBeUndefined();
  });
  it('refuses a changed file or a session that became live after preview', async () => {
    const path = await file('states/old.json');
    const stateDir = join(root, 'states');
    const metadataDir = join(root, 'metadata');
    const candidates = await listSessionStateCandidates(stateDir, metadataDir, new Set(), now);
    await expect(removeSessionStateCandidates(candidates, stateDir, metadataDir, () => new Set(['old']), now)).rejects.toThrow();
    await fs.writeFile(path, 'changed fixture');
    await expect(removeSessionStateCandidates(candidates, stateDir, metadataDir, () => new Set(), now)).rejects.toThrow();
    await expect(fs.access(path)).resolves.toBeUndefined();
  });
});
