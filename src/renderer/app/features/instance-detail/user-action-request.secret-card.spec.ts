import { describe, expect, it } from 'vitest';

import { secretFormatWarning, SecretCardDrafts } from './user-action-request.secret-card';

describe('secretFormatWarning', () => {
  it('warns when a value does not start with a GitHub PAT prefix', () => {
    expect(secretFormatWarning('github_pat', 'not-a-token')).toBe(
      'This does not look like a GitHub personal access token.',
    );
  });

  it('accepts the classic ghp_ prefix', () => {
    expect(secretFormatWarning('github_pat', 'ghp_examplePlaceholder0000000000000')).toBeNull();
  });

  it('accepts the fine-grained github_pat_ prefix', () => {
    expect(secretFormatWarning('github_pat', 'github_pat_examplePlaceholder0000')).toBeNull();
  });

  it('warns when an OpenAI key does not start with sk-', () => {
    expect(secretFormatWarning('openai_key', 'wrong-prefix-key')).toBe(
      'This does not look like an OpenAI API key.',
    );
  });

  it('accepts a value with the sk- prefix', () => {
    expect(secretFormatWarning('openai_key', 'sk-examplePlaceholder0000000000000')).toBeNull();
  });

  it('never warns for opaque or bearer formats', () => {
    expect(secretFormatWarning('opaque', 'anything at all')).toBeNull();
    expect(secretFormatWarning('bearer', 'anything at all')).toBeNull();
  });

  it('never warns for an undefined format hint', () => {
    expect(secretFormatWarning(undefined, 'anything at all')).toBeNull();
  });

  it('never warns while the field is empty or whitespace-only', () => {
    expect(secretFormatWarning('github_pat', '')).toBeNull();
    expect(secretFormatWarning('github_pat', '   ')).toBeNull();
  });
});

describe('SecretCardDrafts.value', () => {
  it('returns the stored draft without removing it', () => {
    const drafts = new SecretCardDrafts();
    drafts.set('req-1', 'draft-value');

    expect(drafts.value('req-1')).toBe('draft-value');
    expect(drafts.value('req-1')).toBe('draft-value');
    expect(drafts.has('req-1')).toBe(true);
  });

  it('returns an empty string for an unknown request id', () => {
    const drafts = new SecretCardDrafts();
    expect(drafts.value('missing')).toBe('');
  });
});
