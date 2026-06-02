import { describe, expect, it } from 'vitest';
import {
  frontLoadTitle,
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

  it('prefers the cheap-AI title over the raw first message when present', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          aiTitle: 'UnstablePvP coin audit',
          firstUserMessage: 'Please review this PR [UnstablePvP/unstable-core#42]',
        })
      )
    ).toBe('UnstablePvP coin audit');
  });

  it('still honours a user rename over the AI title', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({ isRenamed: true, displayName: 'My Name', aiTitle: 'AI Name' })
      )
    ).toBe('My Name');
  });

  it('front-loads the first message when no AI title exists', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({ firstUserMessage: 'We need to harden UnstablePvP coin accounting' })
      )
    ).toBe('Harden UnstablePvP coin accounting');
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

describe('frontLoadTitle', () => {
  it('strips a polite lead-in and a "<verb> this" framing (screenshot cases)', () => {
    expect(frontLoadTitle('Please review this PR: [UnstablePvP/unstable-core#42]'))
      .toBe('UnstablePvP/unstable-core#42]');
    expect(frontLoadTitle('Please review this PR [UnstablePvP/unstable-core]'))
      .toBe('UnstablePvP/unstable-core]');
    expect(frontLoadTitle('We need to harden UnstablePvP coin accounting'))
      .toBe('Harden UnstablePvP coin accounting');
  });

  it('shortens a leading absolute path to its last two segments', () => {
    expect(frontLoadTitle('Please implement this /Users/suas/work/Minecraft/Noah'))
      .toBe('…/Minecraft/Noah');
  });

  it('turns a leading bare URL into a readable host + path', () => {
    expect(frontLoadTitle('[https://docs.google.com/document/d/1T1w4abc/edit]'))
      .toBe('Docs.google.com/document');
  });

  it('peels stacked lead-ins', () => {
    expect(frontLoadTitle('Hey, can you please fix this bug in the parser'))
      .toBe('Bug in the parser');
  });

  it('does not over-strip a verb followed by a specific noun', () => {
    expect(frontLoadTitle('Investigate the broken deployment'))
      .toBe('Investigate the broken deployment');
  });

  it('returns the normalized original when stripping would leave too little', () => {
    expect(frontLoadTitle('Please fix this')).toBe('Please fix this');
  });

  it('returns empty string for blank input', () => {
    expect(frontLoadTitle('   ')).toBe('');
    expect(frontLoadTitle(undefined)).toBe('');
  });

  it('titles a loop-with-attachments prompt from its files, not the injected header', () => {
    const prompt = [
      'Attached files (relative to workspace; use your file-read tools):',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-05-30-mobile-control-app-plan.md',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-chrome-devtools-managed-profile-attach.md',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-outstanding-work-master-backlog.md',
      '',
      'Please work these files and implement them. Be thorough.',
    ].join('\n');
    // Before the fix this returned "Attached files (relative to workspace; use…".
    expect(frontLoadTitle(prompt)).toBe('Mobile control app implementation');
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
