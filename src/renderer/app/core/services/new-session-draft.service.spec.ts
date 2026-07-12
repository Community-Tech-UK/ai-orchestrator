import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NewSessionDraftService } from './new-session-draft.service';
import { ProviderStateService } from './provider-state.service';
import { WorkspaceIpcService } from './ipc/workspace-ipc.service';
import { ScratchDirectoryService } from './scratch-directory.service';
import { clearKnownModelCatalogSnapshotForTesting } from '../../../../shared/types/provider.types';

/**
 * Lightweight stub of ProviderStateService so we don't have to spin up
 * SettingsStore + SettingsIpcService for these draft-state-only tests.
 * The real per-provider memory behavior is exercised in the
 * ProviderStateService specs.
 */
class StubProviderStateService {
  private remembered = new Map<string, string>();
  private rememberedLaunchModes = new Map<string, string>();
  getLastModelForProvider(): undefined {
    return undefined;
  }
  rememberModelForProvider(provider: string, model: string): void {
    this.remembered.set(provider, model);
  }
  getLaunchModeForProvider(provider: string): string {
    return this.rememberedLaunchModes.get(provider) ?? 'orchestrated';
  }
  rememberLaunchModeForProvider(provider: string, launchMode: string): void {
    this.rememberedLaunchModes.set(provider, launchMode);
  }
}

function createService(): NewSessionDraftService {
  return TestBed.inject(NewSessionDraftService);
}

describe('NewSessionDraftService', () => {
  let service: NewSessionDraftService;
  let workspaceIpc: { hintActive: ReturnType<typeof vi.fn> };
  let scratchDirectory: {
    init: ReturnType<typeof vi.fn>;
    isScratch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    window.localStorage.clear();
    clearKnownModelCatalogSnapshotForTesting();
    workspaceIpc = {
      hintActive: vi.fn().mockResolvedValue(true),
    };
    scratchDirectory = {
      init: vi.fn().mockResolvedValue(undefined),
      isScratch: vi.fn((path: string | null | undefined) => path === '/Users/suas/.ai-orchestrator/scratch'),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        NewSessionDraftService,
        { provide: ProviderStateService, useClass: StubProviderStateService },
        { provide: WorkspaceIpcService, useValue: workspaceIpc },
        { provide: ScratchDirectoryService, useValue: scratchDirectory },
      ],
    });
    service = createService();
  });

  it('moves the default draft into a project when the project draft is empty', () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

    service.setPrompt('Investigate the sidebar state');
    service.setProvider('gemini');
    service.setModel('gemini-2.5-pro');
    service.setAgentId('plan');
    service.addPendingFolder('/Users/suas/work/orchestrat0r');
    service.addPendingFiles([file]);

    service.setWorkingDirectory('/Users/suas/work/orchestrat0r/claude-orchestrator');

    expect(service.workingDirectory()).toBe('/Users/suas/work/orchestrat0r/claude-orchestrator');
    expect(service.prompt()).toBe('Investigate the sidebar state');
    expect(service.provider()).toBe('gemini');
    expect(service.model()).toBe('gemini-2.5-pro');
    expect(service.agentId()).toBe('plan');
    expect(service.pendingFolders()).toEqual(['/Users/suas/work/orchestrat0r']);
    expect(service.pendingFiles()).toEqual([file]);

    service.open(null);
    expect(service.prompt()).toBe('');
    expect(service.agentId()).toBe('build');
  });

  it('sets and carries a local model runtime target into an empty project draft', () => {
    const modelRuntimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen2.5',
    };

    service.setPrompt('Use the local model');
    service.setModelRuntimeTarget(modelRuntimeTarget);

    expect(service.provider()).toBe('auto');
    expect(service.model()).toBe('qwen2.5');
    expect(service.nodeId()).toBe('node-win');
    expect(service.modelRuntimeTarget()).toEqual(modelRuntimeTarget);

    service.setWorkingDirectory('/Users/suas/work/orchestrat0r/claude-orchestrator');

    expect(service.provider()).toBe('auto');
    expect(service.model()).toBe('qwen2.5');
    expect(service.nodeId()).toBe('node-win');
    expect(service.modelRuntimeTarget()).toEqual(modelRuntimeTarget);
  });

  it('clears a this-device local model runtime target when a remote node is selected', () => {
    const modelRuntimeTarget = {
      kind: 'local-model' as const,
      source: 'this-device' as const,
      selectorId: 'lm://this-device/ollama/ollama/qwen2.5',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen2.5',
    };

    service.setModelRuntimeTarget(modelRuntimeTarget);
    service.setNodeId('node-win');

    expect(service.nodeId()).toBe('node-win');
    expect(service.modelRuntimeTarget()).toBeNull();
  });

  it('clears the active composer without discarding scoped provider or model choices', () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
    service.setPrompt('Need a fresh brief');
    service.setProvider('codex');
    service.setModel('gpt-5-codex');
    service.setAgentId('plan');
    service.addPendingFolder('/Users/suas/work/opencode');
    service.addPendingFiles([file]);

    service.clearActiveComposer();

    expect(service.workingDirectory()).toBe('/Users/suas/work/orchestrat0r/claude-orchestrator');
    expect(service.prompt()).toBe('');
    expect(service.pendingFolders()).toEqual([]);
    expect(service.pendingFiles()).toEqual([]);
    expect(service.agentId()).toBe('build');
    expect(service.provider()).toBe('codex');     // unchanged
    expect(service.model()).toBe('gpt-5-codex');  // unchanged
  });

  it('reports saved drafts for project-scoped pending files', () => {
    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
    service.addPendingFiles([new File(['a'], 'draft.txt', { type: 'text/plain' })]);

    expect(service.hasSavedDraftFor('/Users/suas/work/orchestrat0r/claude-orchestrator')).toBe(true);
  });

  it('hints the active workspace when opening a project draft', async () => {
    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator', 'node-1');
    await Promise.resolve();

    expect(service.workingDirectory()).toBe('/Users/suas/work/orchestrat0r/claude-orchestrator');
    expect(service.nodeId()).toBe('node-1');
    expect(workspaceIpc.hintActive).toHaveBeenCalledWith(
      '/Users/suas/work/orchestrat0r/claude-orchestrator',
      'node-1',
    );
  });

  it('reuses the draft node when reopening a project draft without an explicit node', async () => {
    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator', 'node-1');
    await Promise.resolve();
    workspaceIpc.hintActive.mockClear();

    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
    await Promise.resolve();

    expect(service.nodeId()).toBe('node-1');
    expect(workspaceIpc.hintActive).toHaveBeenCalledWith(
      '/Users/suas/work/orchestrat0r/claude-orchestrator',
      'node-1',
    );
  });

  it('does not hint a workspace when opening the default draft', () => {
    service.open(null);

    expect(service.workingDirectory()).toBeNull();
    expect(workspaceIpc.hintActive).not.toHaveBeenCalled();
  });

  it('does not hint the scratch workspace when opening a scratch draft directly', async () => {
    service.open('/Users/suas/.ai-orchestrator/scratch');
    await Promise.resolve();

    expect(service.workingDirectory()).toBe('/Users/suas/.ai-orchestrator/scratch');
    expect(workspaceIpc.hintActive).not.toHaveBeenCalled();
  });

  it('defaults agentId to "build" on a fresh draft', () => {
    expect(service.agentId()).toBe('build');
  });

  it('updates agentId via setAgentId', () => {
    service.setAgentId('plan');
    expect(service.agentId()).toBe('plan');
  });

  it('persists agentId across reload', () => {
    vi.useFakeTimers();
    try {
      service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      service.setAgentId('review');
      vi.advanceTimersByTime(250);

      // Re-instantiate via a fresh injector so the constructor reloads from localStorage.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          NewSessionDraftService,
          { provide: ProviderStateService, useClass: StubProviderStateService },
          { provide: WorkspaceIpcService, useValue: workspaceIpc },
          { provide: ScratchDirectoryService, useValue: scratchDirectory },
        ],
      });
      const reloaded = createService();
      reloaded.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      expect(reloaded.agentId()).toBe('review');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates legacy persisted records (no agentId field) to "build"', () => {
    window.localStorage.setItem(
      'new-session-drafts:v1',
      JSON.stringify({
        version: 1,
        activeKey: '__default__',
        drafts: {
          __default__: {
            workingDirectory: null,
            prompt: 'old draft',
            provider: null,
            model: null,
            pendingFolders: [],
            updatedAt: 0,
          },
        },
      }),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        NewSessionDraftService,
        { provide: ProviderStateService, useClass: StubProviderStateService },
        { provide: WorkspaceIpcService, useValue: workspaceIpc },
        { provide: ScratchDirectoryService, useValue: scratchDirectory },
      ],
    });
    const reloaded = createService();
    expect(reloaded.agentId()).toBe('build');
  });

  it('hydrates an unknown agent id to "build"', () => {
    window.localStorage.setItem(
      'new-session-drafts:v1',
      JSON.stringify({
        version: 1,
        activeKey: '__default__',
        drafts: {
          __default__: {
            workingDirectory: null,
            prompt: '',
            provider: null,
            model: null,
            agentId: 'made-up-agent',
            pendingFolders: [],
            updatedAt: 0,
          },
        },
      }),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        NewSessionDraftService,
        { provide: ProviderStateService, useClass: StubProviderStateService },
        { provide: WorkspaceIpcService, useValue: workspaceIpc },
        { provide: ScratchDirectoryService, useValue: scratchDirectory },
      ],
    });
    const reloaded = createService();
    expect(reloaded.agentId()).toBe('build');
  });

  it('preserves a persisted strict-provider draft model before the unified catalog has loaded', () => {
    window.localStorage.setItem(
      'new-session-drafts:v1',
      JSON.stringify({
        version: 1,
        activeKey: 'project:/repo',
        drafts: {
          'project:/repo': {
            workingDirectory: '/repo',
            prompt: 'Use the override model',
            provider: 'claude',
            model: 'claude-local-opus',
            agentId: 'build',
            pendingFolders: [],
            updatedAt: 0,
          },
        },
      }),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        NewSessionDraftService,
        { provide: ProviderStateService, useClass: StubProviderStateService },
        { provide: WorkspaceIpcService, useValue: workspaceIpc },
        { provide: ScratchDirectoryService, useValue: scratchDirectory },
      ],
    });

    const reloaded = createService();
    expect(reloaded.provider()).toBe('claude');
    expect(reloaded.model()).toBe('claude-local-opus');
  });

  it('persists reasoningEffort via setReasoningEffort', () => {
    const service = createService();
    expect(service.reasoningEffort()).toBeNull();

    service.setReasoningEffort('high');
    expect(service.reasoningEffort()).toBe('high');

    service.setReasoningEffort(null);
    expect(service.reasoningEffort()).toBeNull();
  });

  it('resets reasoningEffort to the new provider default when provider changes', () => {
    const service = createService();
    service.setProvider('claude');
    service.setReasoningEffort('max');
    expect(service.reasoningEffort()).toBe('max');

    service.setProvider('codex');
    expect(service.reasoningEffort()).toBe('high');

    service.setProvider('gemini');
    expect(service.reasoningEffort()).toBeNull();
  });

  it('defaults reasoningEffort to High when switching to Claude', () => {
    const service = createService();
    service.setProvider('gemini');
    expect(service.reasoningEffort()).toBeNull();

    service.setProvider('claude');
    expect(service.reasoningEffort()).toBe('high');
  });

  it('preserves reasoningEffort when re-setting the same provider', () => {
    const service = createService();
    service.setProvider('claude');
    service.setReasoningEffort('high');

    service.setProvider('claude');
    expect(service.reasoningEffort()).toBe('high');
  });

  it('persists Claude launch mode across reload', () => {
    vi.useFakeTimers();
    try {
      service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      service.setProvider('claude');
      service.setLaunchMode('interactive');
      vi.advanceTimersByTime(250);

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          NewSessionDraftService,
          { provide: ProviderStateService, useClass: StubProviderStateService },
          { provide: WorkspaceIpcService, useValue: workspaceIpc },
          { provide: ScratchDirectoryService, useValue: scratchDirectory },
        ],
      });
      const reloaded = createService();
      reloaded.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      expect(reloaded.launchMode()).toBe('interactive');
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists local model runtime targets across reload', () => {
    const modelRuntimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen2.5',
    };

    vi.useFakeTimers();
    try {
      service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      service.setModelRuntimeTarget(modelRuntimeTarget);
      vi.advanceTimersByTime(250);

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          NewSessionDraftService,
          { provide: ProviderStateService, useClass: StubProviderStateService },
          { provide: WorkspaceIpcService, useValue: workspaceIpc },
          { provide: ScratchDirectoryService, useValue: scratchDirectory },
        ],
      });
      const reloaded = createService();
      reloaded.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      expect(reloaded.provider()).toBe('auto');
      expect(reloaded.model()).toBe('qwen2.5');
      expect(reloaded.nodeId()).toBe('node-win');
      expect(reloaded.modelRuntimeTarget()).toEqual(modelRuntimeTarget);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops persisted worker local model runtime targets without nodeId', () => {
    const modelRuntimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen2.5',
    };

    vi.useFakeTimers();
    try {
      service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      service.setModelRuntimeTarget(modelRuntimeTarget);
      vi.advanceTimersByTime(250);

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          NewSessionDraftService,
          { provide: ProviderStateService, useClass: StubProviderStateService },
          { provide: WorkspaceIpcService, useValue: workspaceIpc },
          { provide: ScratchDirectoryService, useValue: scratchDirectory },
        ],
      });
      const reloaded = createService();
      reloaded.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      expect(reloaded.modelRuntimeTarget()).toBeNull();
      expect(reloaded.nodeId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops persisted local model runtime targets whose selector disagrees with target fields', () => {
    const modelRuntimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
      nodeId: 'node-other',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen2.5',
    };

    vi.useFakeTimers();
    try {
      service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      service.setModelRuntimeTarget(modelRuntimeTarget);
      vi.advanceTimersByTime(250);

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          NewSessionDraftService,
          { provide: ProviderStateService, useClass: StubProviderStateService },
          { provide: WorkspaceIpcService, useValue: workspaceIpc },
          { provide: ScratchDirectoryService, useValue: scratchDirectory },
        ],
      });
      const reloaded = createService();
      reloaded.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      expect(reloaded.modelRuntimeTarget()).toBeNull();
      expect(reloaded.nodeId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops persisted this-device local model runtime targets with nodeId', () => {
    const modelRuntimeTarget = {
      kind: 'local-model' as const,
      source: 'this-device' as const,
      selectorId: 'lm://this-device/ollama/ollama/qwen2.5',
      nodeId: 'node-win',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen2.5',
    };

    vi.useFakeTimers();
    try {
      service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      service.setModelRuntimeTarget(modelRuntimeTarget);
      vi.advanceTimersByTime(250);

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          NewSessionDraftService,
          { provide: ProviderStateService, useClass: StubProviderStateService },
          { provide: WorkspaceIpcService, useValue: workspaceIpc },
          { provide: ScratchDirectoryService, useValue: scratchDirectory },
        ],
      });
      const reloaded = createService();
      reloaded.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
      expect(reloaded.modelRuntimeTarget()).toBeNull();
      expect(reloaded.nodeId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses remembered Claude launch mode when switching providers', () => {
    service.setProvider('claude');
    service.setLaunchMode('interactive');
    service.setProvider('codex');
    expect(service.launchMode()).toBeNull();

    service.setProvider('claude');
    expect(service.launchMode()).toBe('interactive');
  });
});
