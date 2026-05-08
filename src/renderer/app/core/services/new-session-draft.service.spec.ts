import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NewSessionDraftService } from './new-session-draft.service';
import { ProviderStateService } from './provider-state.service';

/**
 * Lightweight stub of ProviderStateService so we don't have to spin up
 * SettingsStore + SettingsIpcService for these draft-state-only tests.
 * The real per-provider memory behavior is exercised in the
 * ProviderStateService specs.
 */
class StubProviderStateService {
  private remembered = new Map<string, string>();
  getLastModelForProvider(): undefined {
    return undefined;
  }
  rememberModelForProvider(provider: string, model: string): void {
    this.remembered.set(provider, model);
  }
}

function createService(): NewSessionDraftService {
  return TestBed.inject(NewSessionDraftService);
}

describe('NewSessionDraftService', () => {
  let service: NewSessionDraftService;

  beforeEach(() => {
    window.localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        NewSessionDraftService,
        { provide: ProviderStateService, useClass: StubProviderStateService },
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
      ],
    });
    const reloaded = createService();
    expect(reloaded.agentId()).toBe('build');
  });

  it('persists reasoningEffort via setReasoningEffort', () => {
    const service = createService();
    expect(service.reasoningEffort()).toBeNull();

    service.setReasoningEffort('high');
    expect(service.reasoningEffort()).toBe('high');

    service.setReasoningEffort(null);
    expect(service.reasoningEffort()).toBeNull();
  });

  it('clears reasoningEffort when provider changes', () => {
    const service = createService();
    service.setProvider('claude');
    service.setReasoningEffort('high');
    expect(service.reasoningEffort()).toBe('high');

    service.setProvider('codex');
    expect(service.reasoningEffort()).toBeNull();
  });

  it('preserves reasoningEffort when re-setting the same provider', () => {
    const service = createService();
    service.setProvider('claude');
    service.setReasoningEffort('high');

    service.setProvider('claude');
    expect(service.reasoningEffort()).toBe('high');
  });
});
