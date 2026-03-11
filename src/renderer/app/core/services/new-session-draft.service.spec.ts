import { beforeEach, describe, expect, it } from 'vitest';
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
    service.addPendingFolder('/Users/suas/work/orchestrat0r');
    service.addPendingFiles([file]);

    service.setWorkingDirectory('/Users/suas/work/orchestrat0r/claude-orchestrator');

    expect(service.workingDirectory()).toBe('/Users/suas/work/orchestrat0r/claude-orchestrator');
    expect(service.prompt()).toBe('Investigate the sidebar state');
    expect(service.provider()).toBe('gemini');
    expect(service.model()).toBe('gemini-2.5-pro');
    expect(service.pendingFolders()).toEqual(['/Users/suas/work/orchestrat0r']);
    expect(service.pendingFiles()).toEqual([file]);
  });

  it('clears the active composer without discarding scoped provider or model choices', () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
    service.setPrompt('Need a fresh brief');
    service.setProvider('codex');
    service.setModel('gpt-5-codex');
    service.addPendingFolder('/Users/suas/work/opencode');
    service.addPendingFiles([file]);

    service.clearActiveComposer();

    expect(service.workingDirectory()).toBe('/Users/suas/work/orchestrat0r/claude-orchestrator');
    expect(service.prompt()).toBe('');
    expect(service.pendingFolders()).toEqual([]);
    expect(service.pendingFiles()).toEqual([]);
    expect(service.provider()).toBe('codex');
    expect(service.model()).toBe('gpt-5-codex');
  });

  it('reports saved drafts for project-scoped pending files', () => {
    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
    service.addPendingFiles([new File(['a'], 'draft.txt', { type: 'text/plain' })]);

    expect(service.hasSavedDraftFor('/Users/suas/work/orchestrat0r/claude-orchestrator')).toBe(true);
  });
});
