import { describe, expect, it } from 'vitest';
import { providerAcceptsAttachments } from './provider-attachment-support';

describe('providerAcceptsAttachments', () => {
  it.each(['gemini', 'antigravity', 'local-model', 'ollama'])('rejects %s attachments', (provider) => {
    expect(providerAcceptsAttachments(provider)).toBe(false);
  });
  it.each(['claude', 'codex', 'copilot', 'cursor', 'opencode', 'grok', 'auto'])('accepts %s attachments', (provider) => {
    expect(providerAcceptsAttachments(provider)).toBe(true);
  });
});
