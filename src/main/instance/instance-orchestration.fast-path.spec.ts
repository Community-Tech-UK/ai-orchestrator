import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FastPathRetriever } from './orchestration/fast-path-retriever';
import type { FastPathResult } from './instance-types';

interface CommandCall {
  command: string;
  args: string[];
  cwd: string;
}

interface CommandResponse {
  stdout?: string;
  stderr?: string;
  code: number | null;
}

class MockEmitter {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const existing = this.listeners.get(event) ?? [];
    for (const listener of existing) {
      listener(...args);
    }
    return existing.length > 0;
  }
}

interface MockProcess extends MockEmitter {
  stdout: MockEmitter;
  stderr: MockEmitter;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
}

const childProcess = vi.hoisted(() => {
  const state = {
    calls: [] as CommandCall[],
    responses: [] as CommandResponse[],
    spawn: vi.fn((command: string, args: string[], options: { cwd?: string }) => {
      state.calls.push({ command, args, cwd: options.cwd ?? '' });
      const response = state.responses.shift() ?? { code: 1 };
      const proc = new MockEmitter() as MockProcess;
      proc.stdout = new MockEmitter();
      proc.stderr = new MockEmitter();
      proc.exitCode = response.code;
      proc.kill = vi.fn(() => {
        proc.emit('close', null);
      });

      queueMicrotask(() => {
        if (response.stdout) {
          proc.stdout.emit('data', Buffer.from(response.stdout));
        }
        if (response.stderr) {
          proc.stderr.emit('data', Buffer.from(response.stderr));
        }
        proc.emit('close', response.code);
      });

      return proc;
    }),
  };
  return state;
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: childProcess.spawn,
    default: {
      ...actual,
      spawn: childProcess.spawn,
    },
  };
});

vi.mock('../learning/outcome-tracker', () => ({
  OutcomeTracker: {
    getInstance: () => ({
      recordOutcome: vi.fn(),
    }),
  },
}));

vi.mock('../learning/strategy-learner', () => ({
  StrategyLearner: {
    getInstance: () => ({
      getRecommendation: vi.fn(() => ({ confidence: 0 })),
    }),
  },
}));

vi.mock('../memory', () => ({
  getUnifiedMemory: () => ({
    recordTaskOutcome: vi.fn(),
  }),
}));

vi.mock('../learning/habit-tracker', () => ({
  getHabitTracker: () => ({
    recordAction: vi.fn(),
  }),
}));

vi.mock('../learning/preference-store', () => ({
  getPreferenceStore: () => ({
    get: vi.fn(() => undefined),
  }),
}));

function makeRetrieverWithIndexedSearch(
  result: FastPathResult | null,
): FastPathRetriever {
  return new FastPathRetriever({
    indexedCodebaseContext: {
      buildFastPathResult: vi.fn().mockResolvedValue(result),
    },
  });
}

describe('InstanceOrchestrationManager fast-path retrieval', () => {
  beforeEach(() => {
    childProcess.calls.length = 0;
    childProcess.responses.length = 0;
    childProcess.spawn.mockClear();
  });

  it('uses rg --files after git ls-files fails instead of spawning find', async () => {
    childProcess.responses.push(
      { code: 1 },
      { code: 0, stdout: 'src/main.ts\nsrc/app.ts\n' },
    );
    const retriever = new FastPathRetriever();

    const result = await retriever.listFiles('/repo');

    expect(result?.command).toBe('rg');
    expect(result?.files).toEqual(['src/main.ts', 'src/app.ts']);
    expect(childProcess.calls.map((call) => call.command)).toEqual(['git', 'rg']);
  });

  it('does not fall back to recursive grep when rg and git grep are unavailable', async () => {
    childProcess.responses.push(
      { code: 2 },
      { code: 2 },
    );
    const retriever = new FastPathRetriever();

    const result = await retriever.grep('needle', '/repo');

    expect(result).toBeNull();
    expect(childProcess.calls.map((call) => call.command)).toEqual(['rg', 'git']);
  });

  it('uses indexed codebase search before shell grep for retrieval tasks', async () => {
    const indexedResult: FastPathResult = {
      mode: 'indexed-codebase',
      command: 'codebase-index',
      args: ['search', 'find auth middleware'],
      rawOutput: 'src/auth/middleware.ts:10: requireAuth',
      totalMatches: 1,
      lines: ['src/auth/middleware.ts:10: requireAuth'],
      cwd: '/repo',
    };
    const retriever = makeRetrieverWithIndexedSearch(indexedResult);

    const result = await retriever.search('find auth middleware', '/repo');

    expect(result).toEqual(indexedResult);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
