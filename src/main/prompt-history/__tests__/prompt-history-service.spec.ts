import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PromptHistoryDelta,
  PromptHistoryProjectAlias,
  PromptHistoryRecord,
  PromptHistoryStoreV1,
} from '../../../shared/types/prompt-history.types';
import {
  PROMPT_HISTORY_MAX,
  createPromptHistoryEntryId,
} from '../../../shared/types/prompt-history.types';
import {
  PROMPT_HISTORY_MAX_SESSIONS,
  PROMPT_HISTORY_RECENT_SESSIONS_KEPT,
  PromptHistoryService,
  _resetPromptHistoryServiceForTesting,
} from '../prompt-history-service';
import type { PromptHistoryStoreBackend } from '../prompt-history-store';

class MemoryPromptHistoryStore implements PromptHistoryStoreBackend {
  private data: PromptHistoryStoreV1 = {
    schemaVersion: 1,
    byInstance: {},
    byProject: {},
  };

  get<K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K] {
    return this.data[key];
  }

  setMany(values: Partial<PromptHistoryStoreV1>): void {
    this.data = {
      ...this.data,
      ...values,
    };
  }

  async flush(): Promise<void> {
    // Nothing is pending in memory-only storage.
  }

  keepBackupCopy = vi.fn(async () => undefined);
}

describe('PromptHistoryService', () => {
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    _resetPromptHistoryServiceForTesting();
  });

  afterEach(() => {
    for (const cleanupPath of cleanupPaths.splice(0)) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
  });

  it('records entries most-recent first for an instance', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({
      instanceId: 'inst-1',
      id: createPromptHistoryEntryId(),
      text: 'first',
      createdAt: 1,
    });
    svc.record({
      instanceId: 'inst-1',
      id: createPromptHistoryEntryId(),
      text: 'second',
      createdAt: 2,
    });

    expect(svc.getForInstance('inst-1').entries.map((entry) => entry.text)).toEqual(['second', 'first']);
  });

  it('dedupes repeated prompt text and keeps the latest entry', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({ instanceId: 'inst-1', id: 'old', text: 'same', createdAt: 1 });
    svc.record({ instanceId: 'inst-1', id: 'new', text: 'same', createdAt: 2 });

    expect(svc.getForInstance('inst-1').entries).toMatchObject([{ id: 'new', text: 'same' }]);
  });

  it('caps instance history at PROMPT_HISTORY_MAX', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    for (let i = 0; i < PROMPT_HISTORY_MAX + 5; i++) {
      svc.record({
        instanceId: 'inst-1',
        id: `entry-${i}`,
        text: `prompt ${i}`,
        createdAt: i,
      });
    }

    const entries = svc.getForInstance('inst-1').entries;
    expect(entries).toHaveLength(PROMPT_HISTORY_MAX);
    expect(entries[0]?.text).toBe(`prompt ${PROMPT_HISTORY_MAX + 4}`);
  });

  it('merges prompts from several sessions into one project list', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({
      instanceId: 'inst-1',
      id: 'a',
      text: 'shared project prompt',
      createdAt: 1,
      projectPath: '/repo',
    });
    svc.record({
      instanceId: 'inst-2',
      id: 'b',
      text: 'newer project prompt',
      createdAt: 2,
      projectPath: '/repo',
    });

    expect(svc.getForProject('/repo').entries.map((entry) => entry.text)).toEqual([
      'newer project prompt',
      'shared project prompt',
    ]);
  });

  it('saves once per prompt and changes only that prompt\'s project list', () => {
    const store = new MemoryPromptHistoryStore();
    const svc = new PromptHistoryService(store);
    svc.record({ instanceId: 'inst-1', id: 'a', text: 'other project', createdAt: 1, projectPath: '/other' });
    const otherList = store.get('byProject')['/other'];
    const setMany = vi.spyOn(store, 'setMany');

    svc.record({ instanceId: 'inst-2', id: 'b', text: 'repo prompt', createdAt: 2, projectPath: '/repo' });

    expect(setMany).toHaveBeenCalledTimes(1);
    expect(store.get('byProject')['/other']).toBe(otherList);
    expect(store.get('byProject')['/repo']?.entries.map((entry) => entry.text)).toEqual(['repo prompt']);
  });

  it('sends the changed project list with each change', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());
    const deltas: PromptHistoryDelta[] = [];
    svc.onChange((delta) => deltas.push(delta));

    svc.record({ instanceId: 'inst-1', id: 'a', text: 'hello', createdAt: 1, projectPath: '/repo' });
    svc.record({ instanceId: 'inst-1', id: 'b', text: 'no project', createdAt: 2 });
    svc.clearForInstance('inst-1');

    expect(deltas[0]?.projectAliases).toEqual([
      expect.objectContaining({ projectPath: '/repo', entries: [expect.objectContaining({ id: 'a' })] }),
    ]);
    expect(deltas[1]).not.toHaveProperty('projectAliases');
    expect(deltas[2]?.projectAliases).toEqual([expect.objectContaining({ projectPath: '/repo', entries: [] })]);
  });


  it('normalizes project aliases while preserving raw lookup compatibility', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-project-'));
    cleanupPaths.push(root);
    const realProject = path.join(root, 'real');
    const linkedProject = path.join(root, 'linked');
    fs.mkdirSync(realProject);
    fs.symlinkSync(realProject, linkedProject, process.platform === 'win32' ? 'junction' : 'dir');

    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());
    svc.record({
      instanceId: 'inst-1',
      id: 'a',
      text: 'from symlink',
      createdAt: 1,
      projectPath: linkedProject,
    });

    expect(svc.getForProject(realProject).entries.map((entry) => entry.text)).toEqual(['from symlink']);
    expect(svc.getForProject(`${realProject}/`).entries.map((entry) => entry.text)).toEqual(['from symlink']);
    expect(svc.getForProject(linkedProject).entries.map((entry) => entry.text)).toEqual(['from symlink']);
  });

  it('clears one instance and updates aliases', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({ instanceId: 'inst-1', id: 'a', text: 'remove me', createdAt: 1, projectPath: '/repo' });
    svc.record({ instanceId: 'inst-2', id: 'b', text: 'keep me', createdAt: 2, projectPath: '/repo' });
    svc.clearForInstance('inst-1');

    expect(svc.getForInstance('inst-1').entries).toEqual([]);
    expect(svc.getForProject('/repo').entries.map((entry) => entry.text)).toEqual(['keep me']);
  });

  it('removes a cleared session\'s prompts from every project list it reached', () => {
    const store = new MemoryPromptHistoryStore();
    const svc = new PromptHistoryService(store);
    svc.record({ instanceId: 'inst-1', id: 'a', text: 'only here', createdAt: 1, projectPath: '/solo' });
    svc.record({ instanceId: 'inst-1', id: 'b', text: 'shared', createdAt: 2, projectPath: '/repo' });
    svc.record({ instanceId: 'inst-2', id: 'c', text: 'kept', createdAt: 3, projectPath: '/repo' });

    svc.clearForInstance('inst-1');

    expect(store.get('byProject')['/solo']).toBeUndefined();
    expect(svc.getForProject('/repo').entries.map((entry) => entry.text)).toEqual(['kept']);
  });

  it('keeps a prompt in the project list when another session still has the same text', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());
    svc.record({ instanceId: 'inst-2', id: 'older', text: 'same words', createdAt: 1, projectPath: '/repo' });
    svc.record({ instanceId: 'inst-1', id: 'newer', text: 'same words', createdAt: 2, projectPath: '/repo' });

    svc.clearForInstance('inst-1');

    expect(svc.getForProject('/repo').entries).toMatchObject([{ id: 'older', text: 'same words' }]);
  });

  describe('pruneOnStart', () => {
    const NOW = Date.UTC(2026, 10, 9);
    const DAY = 24 * 60 * 60_000;

    function record(instanceId: string, updatedAt: number, texts: string[], projectPath?: string): PromptHistoryRecord {
      return {
        instanceId,
        updatedAt,
        entries: texts.map((text, index) => ({ id: `${instanceId}-${index}`, text, createdAt: updatedAt - index, projectPath })),
      };
    }

    function alias(projectPath: string, createdAt: number): PromptHistoryProjectAlias {
      return { projectPath, updatedAt: NOW, entries: [{ id: `${projectPath}-entry`, text: 'p', createdAt, projectPath }] };
    }

    it('keeps the newest sessions and recent sessions with 2+ prompts, and drops the rest', async () => {
      const store = new MemoryPromptHistoryStore();
      const byInstance: Record<string, PromptHistoryRecord> = {
        'busy-recent': record('busy-recent', NOW - 80 * DAY, ['one', 'two']),
        'busy-old': record('busy-old', NOW - 100 * DAY, ['one', 'two']),
        'single-old': record('single-old', NOW - 95 * DAY, ['only']),
        empty: { instanceId: 'empty', updatedAt: NOW, entries: [] },
      };
      for (let index = 0; index < PROMPT_HISTORY_RECENT_SESSIONS_KEPT; index += 1) {
        byInstance[`new-${index}`] = record(`new-${index}`, NOW - index, ['single']);
      }
      store.setMany({ byInstance });
      const svc = new PromptHistoryService(store);

      await svc.pruneOnStart(NOW);

      const kept = store.get('byInstance');
      expect(Object.keys(kept)).toHaveLength(PROMPT_HISTORY_RECENT_SESSIONS_KEPT + 1);
      expect(kept['busy-recent']).toBeDefined();
      expect(kept['new-0']).toBeDefined();
      expect(kept['busy-old']).toBeUndefined();
      expect(kept['single-old']).toBeUndefined();
      expect(kept['empty']).toBeUndefined();
      expect(store.keepBackupCopy).toHaveBeenCalledOnce();
    });

    it('keeps project lists for existing folders, and recently used missing ones', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-prune-'));
      cleanupPaths.push(root);
      const missing = path.join(root, 'gone');
      const store = new MemoryPromptHistoryStore();
      store.setMany({
        byProject: {
          [root]: alias(root, NOW - 60 * DAY),
          [`${missing}-recent`]: alias(`${missing}-recent`, NOW - 3 * DAY),
          [`${missing}-stale`]: alias(`${missing}-stale`, NOW - 10 * DAY),
          [`${root}-old`]: alias(`${root}-old`, NOW - 91 * DAY),
        },
      });
      const svc = new PromptHistoryService(store);

      await svc.pruneOnStart(NOW);

      expect(Object.keys(store.get('byProject')).sort()).toEqual([root, `${missing}-recent`].sort());
    });

    it('caps stored sessions while recording, but only after the startup cleanup', async () => {
      const store = new MemoryPromptHistoryStore();
      const byInstance: Record<string, PromptHistoryRecord> = {};
      for (let index = 0; index < PROMPT_HISTORY_MAX_SESSIONS + 50; index += 1) {
        byInstance[`s-${index}`] = record(`s-${index}`, Date.now() - index, ['a', 'b']);
      }
      store.setMany({ byInstance });
      const svc = new PromptHistoryService(store);

      // Before the cleanup has kept its backup, recording must not drop sessions.
      svc.record({ instanceId: 'early', id: 'e', text: 'early prompt', createdAt: Date.now() });
      expect(Object.keys(store.get('byInstance'))).toHaveLength(PROMPT_HISTORY_MAX_SESSIONS + 51);
      expect(store.keepBackupCopy).not.toHaveBeenCalled();

      await svc.pruneOnStart();
      expect(store.keepBackupCopy).toHaveBeenCalledOnce();
      expect(Object.keys(store.get('byInstance'))).toHaveLength(PROMPT_HISTORY_MAX_SESSIONS);

      svc.record({ instanceId: 'newest', id: 'n', text: 'newest prompt', createdAt: Date.now() });

      expect(Object.keys(store.get('byInstance'))).toHaveLength(PROMPT_HISTORY_MAX_SESSIONS);
      expect(store.get('byInstance')['newest']).toBeDefined();
    });

    it('takes no backup and keeps everything when nothing is old', async () => {
      const store = new MemoryPromptHistoryStore();
      store.setMany({ byInstance: { fresh: record('fresh', NOW, ['hi']) } });
      const svc = new PromptHistoryService(store);

      await svc.pruneOnStart(NOW);

      expect(Object.keys(store.get('byInstance'))).toEqual(['fresh']);
      expect(store.keepBackupCopy).not.toHaveBeenCalled();
    });
  });

  it('emits deltas when records change', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());
    const seen: string[] = [];
    const unsubscribe = svc.onChange((delta) => {
      seen.push(`${delta.instanceId}:${delta.record.entries.length}`);
    });

    svc.record({ instanceId: 'inst-1', id: 'a', text: 'hello', createdAt: 1 });
    svc.clearForInstance('inst-1');
    unsubscribe();
    svc.record({ instanceId: 'inst-1', id: 'b', text: 'world', createdAt: 2 });

    expect(seen).toEqual(['inst-1:1', 'inst-1:0']);
  });
});
