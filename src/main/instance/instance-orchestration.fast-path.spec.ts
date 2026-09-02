import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FastPathRetriever } from './orchestration/fast-path-retriever';
import type { FastPathResult } from './instance-types';
import type { Instance } from '../../shared/types/instance.types';
import type { TaskExecution } from '../../shared/types/task.types';
import { InstanceOrchestrationManager } from './instance-orchestration';

const orchestrationSpies = vi.hoisted(() => ({
  memoryModuleResolutions: 0,
  getUnifiedMemory: vi.fn(() => ({
    recordTaskOutcome: vi.fn(),
  })),
  rlmGetInstance: vi.fn(),
  rlmConstructions: vi.fn(),
  recordOutcome: vi.fn(),
  recordHabit: vi.fn(),
}));

interface RuntimeImport {
  moduleSpecifier: string;
  importedNames: string[];
}

function getRuntimeImports(filePath: string): RuntimeImport[] {
  const source = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: RuntimeImport[] = [];

  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }

    const clause = node.importClause;
    if (clause?.isTypeOnly) return;

    const importedNames: string[] = [];
    if (!clause) {
      importedNames.push('<side-effect>');
    } else {
      if (clause.name) importedNames.push('default');
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        importedNames.push('*');
      } else if (bindings) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) {
            importedNames.push((element.propertyName ?? element.name).text);
          }
        }
      }
    }

    if (importedNames.length > 0) {
      imports.push({
        moduleSpecifier: node.moduleSpecifier.text,
        importedNames,
      });
    }
  });

  return imports;
}

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
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

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
      recordOutcome: orchestrationSpies.recordOutcome,
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

vi.mock('../memory', () => {
  orchestrationSpies.memoryModuleResolutions += 1;
  return { getUnifiedMemory: orchestrationSpies.getUnifiedMemory };
});

vi.mock('../rlm/context-manager', () => {
  class MockRLMContextManager {
    static getInstance = orchestrationSpies.rlmGetInstance;

    constructor() {
      orchestrationSpies.rlmConstructions();
    }
  }

  return { RLMContextManager: MockRLMContextManager };
});

vi.mock('../learning/habit-tracker', () => ({
  getHabitTracker: () => ({
    recordAction: orchestrationSpies.recordHabit,
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
    vi.clearAllMocks();
    childProcess.calls.length = 0;
    childProcess.responses.length = 0;
  });

  function createOrchestrationManager(
    recordTaskOutcome = vi.fn(),
  ): InstanceOrchestrationManager {
    const child = {
      id: 'child-1',
      parentId: 'parent-1',
      agentId: 'worker',
      workingDirectory: '/repo',
      outputBuffer: [],
      totalTokensUsed: 17,
    } as unknown as Instance;
    return new InstanceOrchestrationManager({
      getInstance: (id) => id === child.id ? child : undefined,
      getInstanceCount: () => 1,
      createChildInstance: vi.fn(),
      sendInput: vi.fn(),
      terminateInstance: vi.fn(),
      getAdapter: vi.fn(),
      recordTaskOutcome,
    });
  }

  it('constructs without resolving main-process unified memory or its RLM owner', () => {
    createOrchestrationManager();

    expect(orchestrationSpies.memoryModuleResolutions).toBe(0);
    expect(orchestrationSpies.getUnifiedMemory).not.toHaveBeenCalled();
    expect(orchestrationSpies.rlmGetInstance).not.toHaveBeenCalled();
    expect(orchestrationSpies.rlmConstructions).not.toHaveBeenCalled();
  });

  it('has no runtime import capable of resolving main-process unified memory', () => {
    const filePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      'instance-orchestration.ts',
    );
    const forbiddenImports = getRuntimeImports(filePath).filter((entry) =>
      entry.moduleSpecifier === '../memory'
      || entry.moduleSpecifier === '../memory/unified-controller'
      || entry.importedNames.includes('getUnifiedMemory'),
    );

    expect(forbiddenImports).toEqual([]);
  });

  it('delegates one completed child outcome unchanged while preserving local learning writes', () => {
    const recordTaskOutcome = vi.fn();
    const manager = createOrchestrationManager(recordTaskOutcome);
    manager.setupOrchestrationHandlers(
      {
        maxTotalInstances: 0,
        maxChildrenPerParent: 0,
        allowNestedOrchestration: false,
        maxSpawnDepth: 0,
      },
      vi.fn(),
      vi.fn(),
    );
    const task: TaskExecution = {
      taskId: 'task-outcome-47',
      parentId: 'parent-1',
      childId: 'child-1',
      task: 'verify the worker boundary',
      priority: 'normal',
      status: 'completed',
      createdAt: 10,
      startedAt: 20,
      completedAt: 40,
      timeout: 0,
      result: { success: true, summary: 'complete' },
    };

    manager.getOrchestrationHandler().emit(
      'task-complete',
      'parent-1',
      'child-1',
      task,
    );

    expect(recordTaskOutcome).toHaveBeenCalledOnce();
    expect(recordTaskOutcome).toHaveBeenCalledWith('task-outcome-47', true, 1);
    expect(orchestrationSpies.recordOutcome).toHaveBeenCalledOnce();
    expect(orchestrationSpies.recordHabit).toHaveBeenCalledOnce();
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
