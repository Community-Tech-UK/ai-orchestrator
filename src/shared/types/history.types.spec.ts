import { describe, expect, it } from 'vitest';
import {
  getConversationHistoryTitle,
  inferConversationHistoryProvider,
  normalizeConversationHistoryEntryProvider,
  resolveEffectiveInstanceTitle,
  type ConversationHistoryEntry,
} from './history.types';

function makeEntry(
  overrides: Partial<ConversationHistoryEntry> = {}
): ConversationHistoryEntry {
  return {
    id: 'entry-1',
    displayName: 'Project Session',
    createdAt: 1,
    endedAt: 2,
    workingDirectory: '/tmp/project',
    messageCount: 3,
    firstUserMessage: 'Investigate prod error',
    lastUserMessage: 'hi',
    status: 'completed',
    originalInstanceId: 'instance-1',
    parentId: null,
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('history title helpers', () => {
  it('prefers the first user message for a stable thread title', () => {
    expect(getConversationHistoryTitle(makeEntry())).toBe('Investigate prod error');
  });

  it('falls back to the last user message when the first is blank', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          firstUserMessage: '   ',
          lastUserMessage: 'Follow up with the deployment rollback',
        })
      )
    ).toBe('Follow up with the deployment rollback');
  });

  it('falls back to the display name when no user message preview exists', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          firstUserMessage: '',
          lastUserMessage: '',
          displayName: 'MyTradeMail 2',
        })
      )
    ).toBe('MyTradeMail 2');
  });

  it('prefers user-set displayName when isRenamed is true', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          displayName: 'My Custom Title',
          isRenamed: true,
          firstUserMessage: 'Investigate prod error',
        })
      )
    ).toBe('My Custom Title');
  });

  it('normalizes repeated whitespace in previews', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          firstUserMessage: '  Plan   the   smoke   test  ',
        })
      )
    ).toBe('Plan the smoke test');
  });
});

describe('resolveEffectiveInstanceTitle', () => {
  it('returns the live displayName when it is populated', () => {
    // Covers the regression where the sidebar rail diverged from the detail
    // header because the rail preferred the matching history entry's
    // firstUserMessage over the live (auto-titled) displayName.
    expect(
      resolveEffectiveInstanceTitle(
        { displayName: 'Email Password Debug', isRenamed: false },
        makeEntry({ firstUserMessage: 'b' })
      )
    ).toBe('Email Password Debug');
  });

  it('returns a user-renamed displayName verbatim', () => {
    expect(
      resolveEffectiveInstanceTitle(
        { displayName: 'My Custom Name', isRenamed: true },
        makeEntry({ firstUserMessage: 'original task' })
      )
    ).toBe('My Custom Name');
  });

  it('falls back to the matching history entry title when displayName is blank', () => {
    expect(
      resolveEffectiveInstanceTitle(
        { displayName: '   ', isRenamed: false },
        makeEntry({ firstUserMessage: 'Investigate prod error' })
      )
    ).toBe('Investigate prod error');
  });

  it('returns "Untitled thread" when displayName is blank and no history entry is provided', () => {
    expect(
      resolveEffectiveInstanceTitle({ displayName: '', isRenamed: false })
    ).toBe('Untitled thread');
  });

  it('does not require a history entry when displayName is populated', () => {
    expect(
      resolveEffectiveInstanceTitle({ displayName: 'New Session', isRenamed: false })
    ).toBe('New Session');
  });
});

describe('history provider helpers', () => {
  it('keeps an explicit provider when one is already stored', () => {
    expect(
      inferConversationHistoryProvider(
        makeEntry({
          provider: 'gemini',
          sessionId: 'session-1',
        })
      )
    ).toBe('gemini');
  });

  it('infers the provider from a legacy restore identifier prefix', () => {
    expect(
      inferConversationHistoryProvider(
        makeEntry({
          sessionId: 'codex-1772759207884-oc6cdv',
        })
      )
    ).toBe('codex');
  });

  it('infers the provider from a stored model identifier', () => {
    expect(
      inferConversationHistoryProvider(
        makeEntry({
          currentModel: 'gpt-5.3-codex',
        })
      )
    ).toBe('codex');
  });

  it('infers the provider from a direct greeting in legacy titles', () => {
    expect(
      inferConversationHistoryProvider(
        makeEntry({
          firstUserMessage: 'Hey Gemini!',
          lastUserMessage: 'Hey Gemini!',
          displayName: 'Instance 1771720410089',
        })
      )
    ).toBe('gemini');
  });

  it('defaults ambiguous legacy entries to Claude', () => {
    expect(
      inferConversationHistoryProvider(
        makeEntry({
          displayName: 'claude-orchestrator',
          firstUserMessage: 'Can you use your LSP server?',
          lastUserMessage: 'yes',
        })
      )
    ).toBe('claude');
  });

  it('normalizes legacy entries by backfilling the inferred provider', () => {
    expect(
      normalizeConversationHistoryEntryProvider(
        makeEntry({
          sessionId: 'codex-1772541540596-7j0hhg',
        })
      )
    ).toMatchObject({
      provider: 'codex',
    });
  });
});
