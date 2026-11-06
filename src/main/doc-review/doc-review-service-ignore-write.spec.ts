import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocReviewSession } from './doc-review.types';

let workspace: string;

beforeEach(() => {
  vi.resetModules();
  workspace = mkdtempSync(join(tmpdir(), 'doc-review-ignore-write-'));
});

afterEach(() => {
  vi.doUnmock('electron');
  vi.doUnmock('node:fs/promises');
  rmSync(workspace, { recursive: true, force: true });
});

describe('DocReviewService ignore-file lifetime', () => {
  it.each([false, true])('finishes the ignore-file attempt before publishing a review (write fails: %s)', async (failWrite) => {
    mkdirSync(join(workspace, '.aio-review'));
    const artifactPath = join(workspace, '.aio-review', 'review.html');
    writeFileSync(artifactPath, '<meta name="aio-doc-review" content="v1">');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseWrite!: () => void;
    const heldWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markFinished!: () => void;
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const mock = {
        ...actual,
        appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
          markStarted();
          await heldWrite;
          try {
            if (failWrite) throw new Error('simulated ignore-file write failure');
            return await actual.appendFile(...args);
          } finally {
            markFinished();
          }
        },
      };
      return { ...mock, default: mock };
    });
    vi.doMock('electron', () => ({ app: { getPath: () => workspace } }));
    const { DocReviewService, getDocReviewService, DOC_REVIEW_CHANGED_EVENT } = await import('./doc-review-service');
    DocReviewService._resetForTesting();
    const sessions = new Map<string, DocReviewSession>();
    DocReviewService._setStoreFactoryForTesting(() => ({
      list: () => [...sessions.values()],
      get: id => sessions.get(id),
      put: session => { sessions.set(session.id, session); },
      remove: id => sessions.delete(id),
    }));
    const service = getDocReviewService();
    const changed = vi.fn();
    service.on(DOC_REVIEW_CHANGED_EVENT, changed);
    let resolved = false;
    const creation = service.createSession({
      instanceId: 'test-instance', workspacePath: workspace, title: 'Test', artifactPath,
    });
    void creation.then(() => { resolved = true; });
    try {
      await started;
      expect(resolved).toBe(false);
      expect(sessions.size).toBe(0);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      releaseWrite();
      await finished;
      await creation;
      DocReviewService._resetForTesting();
      DocReviewService._setStoreFactoryForTesting(null);
    }
    expect(sessions.size).toBe(1);
    expect(changed).toHaveBeenCalledOnce();
    if (failWrite) {
      expect(existsSync(join(workspace, '.gitignore'))).toBe(false);
    } else {
      expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toContain('.aio-review/');
    }
  });
});
