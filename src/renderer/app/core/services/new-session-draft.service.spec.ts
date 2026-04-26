import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewSessionDraftService } from './new-session-draft.service';

describe('NewSessionDraftService', () => {
  let service: NewSessionDraftService;

  beforeEach(() => {
    window.localStorage.clear();
    service = new NewSessionDraftService();
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

      const reloaded = new NewSessionDraftService();
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

    const reloaded = new NewSessionDraftService();
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

    const reloaded = new NewSessionDraftService();
    expect(reloaded.agentId()).toBe('build');
  });
});
