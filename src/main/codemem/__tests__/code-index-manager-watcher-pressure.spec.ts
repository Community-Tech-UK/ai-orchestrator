import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { CasStore } from '../cas-store';

const chokidarState = vi.hoisted(() => ({
  watchers: [] as any[],
}));

vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    const handlers = new Map<string, Set<(value?: unknown) => void>>();
    const watcher = {
      on: vi.fn((event: string, handler: (value?: unknown) => void) => {
        const eventHandlers = handlers.get(event) ?? new Set();
        eventHandlers.add(handler);
        handlers.set(event, eventHandlers);
        if (event === 'ready') {
          queueMicrotask(() => handler());
        }
        return watcher;
      }),
      off: vi.fn((event: string, handler: (value?: unknown) => void) => {
        handlers.get(event)?.delete(handler);
        return watcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
      emitForTesting(event: string, value?: unknown): void {
        for (const handler of handlers.get(event) ?? []) {
          handler(value);
        }
      },
    };
    chokidarState.watchers.push(watcher);
    return watcher;
  }),
}));

import { watch } from 'chokidar';
import { CodeIndexManager } from '../code-index-manager';
import { workspaceHashForPath } from '../symbol-id';

function createStoreStub(): CasStore {
  return {
    getWorkspaceRoot: vi.fn(() => null),
  } as unknown as CasStore;
}

async function writeFiles(root: string, count: number): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < count; i++) {
    await writeFile(path.join(root, 'src', `file-${i}.ts`), `export const value${i} = ${i};\n`);
  }
}

describe('CodeIndexManager watcher pressure relief', () => {
  let workDir: string;

  beforeEach(async () => {
    chokidarState.watchers.length = 0;
    vi.clearAllMocks();
    workDir = path.join(tmpdir(), `codemem-watch-pressure-${Date.now()}-${Math.random()}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('uses polling instead of native chokidar when a workspace exceeds the native watch file cap', async () => {
    await writeFiles(workDir, 2);
    const manager = new CodeIndexManager({
      store: createStoreStub(),
      debounceMs: 30,
      maxNativeWatchFiles: 1,
    } as any);

    await manager.start(workDir);

    expect(watch).not.toHaveBeenCalled();

    await manager.stop();
  });

  it('closes a native watcher and falls back to polling after runtime EMFILE', async () => {
    await writeFiles(workDir, 1);
    const manager = new CodeIndexManager({
      store: createStoreStub(),
      debounceMs: 30,
      maxNativeWatchFiles: 10,
    } as any);

    await manager.start(workDir);
    expect(chokidarState.watchers).toHaveLength(1);

    chokidarState.watchers[0].emitForTesting(
      'error',
      Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
    );

    await vi.waitFor(() => {
      expect(chokidarState.watchers[0].close).toHaveBeenCalled();
    });

    const workspaceHash = workspaceHashForPath(path.resolve(workDir));
    const activeWatcher = (manager as any).watcher.getWatcherForTesting(workspaceHash);
    expect(activeWatcher).toBeDefined();
    expect(activeWatcher).not.toBe(chokidarState.watchers[0]);

    await manager.stop();
  });

  it('passes native watchers an ignore matcher that prunes dependency directories', async () => {
    await writeFiles(workDir, 1);
    const manager = new CodeIndexManager({
      store: createStoreStub(),
      debounceMs: 30,
      maxNativeWatchFiles: 10,
    } as any);

    await manager.start(workDir);

    const options = vi.mocked(watch).mock.calls[0]?.[1] as { ignored?: unknown } | undefined;
    const ignored = Array.isArray(options?.ignored)
      ? options.ignored
      : [options?.ignored];
    const predicates = ignored.filter(
      (matcher): matcher is (candidatePath: string) => boolean => typeof matcher === 'function',
    );

    expect(predicates.some((predicate) =>
      predicate(path.join(workDir, 'node_modules', 'pkg', 'index.js')),
    )).toBe(true);
    expect(predicates.some((predicate) =>
      predicate(path.join(workDir, 'src', 'file-0.ts')),
    )).toBe(false);

    await manager.stop();
  });
});
