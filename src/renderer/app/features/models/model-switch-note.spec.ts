import { describe, expect, it } from 'vitest';
import { describeModelSwitchEffect } from './model-switch-note';

describe('model switch note', () => {
  const base = { provider: 'claude', hasConversation: true, usedTokens: 152_000 };
  it('shows no note before a conversation exists', () => {
    expect(describeModelSwitchEffect({ ...base, hasConversation: false })).toBeNull();
  });
  it('describes resident local Claude and remote replay truthfully', () => {
    expect(describeModelSwitchEffect({ ...base, residentClaude: true })).toContain('including tool results');
    expect(describeModelSwitchEffect({ ...base, residentClaude: true })).toContain('about 152K tokens');
    expect(describeModelSwitchEffect({ ...base, residentClaude: true, executionLocationType: 'remote' })).toContain('tool results and file contents are not carried over');
  });
  it('names provider replay and hides unreported token counts', () => {
    expect(describeModelSwitchEffect({ ...base, targetProvider: 'codex' })).toContain('Switching provider starts a new session');
    expect(describeModelSwitchEffect({ provider: 'codex', hasConversation: true, usedTokens: null })).not.toContain('K tokens');
    expect(describeModelSwitchEffect({ provider: 'codex', hasConversation: true, usedTokens: 152_000 })).toContain('152K tokens');
  });
  it.each(['gemini', 'antigravity', 'ollama', 'local-model'])('describes shortened replay for %s', provider => {
    const note = describeModelSwitchEffect({ ...base, provider });
    expect(note).toContain('starts a fresh session');
    expect(note).toContain('recent messages in shortened form');
    expect(note).toContain('tool results and file contents are not carried over');
    expect(note).not.toContain('152K tokens');
  });
  it.each(['copilot', 'cursor', 'grok', 'opencode'])('does not promise resume for a local %s agent with unknown capabilities', provider => {
    const note = describeModelSwitchEffect({ ...base, provider });
    expect(note).toContain('If this agent can resume');
    expect(note).toContain('Otherwise');
    expect(note).toContain('recent messages in shortened form');
  });
  it('matches remote resume support, with replay for other remote providers', () => {
    for (const provider of ['codex', 'opencode']) {
      expect(describeModelSwitchEffect({ ...base, provider, executionLocationType: 'remote' }))
        .toBe('The conversation continues with the new model, which reads about 152K tokens of history again at full price.');
    }
    for (const provider of ['gemini', 'copilot', 'cursor', 'grok', 'antigravity']) {
      expect(describeModelSwitchEffect({ ...base, provider, executionLocationType: 'remote' }))
        .toContain('starts a fresh session');
    }
  });
});
