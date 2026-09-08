import { describe, expect, it } from 'vitest';
import {
  frontLoadTitle,
  getConversationHistoryTitle,
  inferConversationHistoryProvider,
  normalizeConversationHistoryEntryProvider,
  resolveEffectiveInstanceTitle,
  type ConversationHistoryEntry,
} from './history.types';
import {
  MAX_FALLBACK_TITLE_LENGTH,
  sanitizeGeneratedTitle,
  truncateForRail,
} from './title-derivation';

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
  it('prefers the stored title over re-deriving from the first message (LT-534b)', () => {
    // The stored title is what the live rail showed: derived from the COMPLETE
    // first message, with line structure and attachment names. `firstUserMessage`
    // is a whitespace-collapsed 150-char preview, so re-deriving from it cannot
    // agree with the live rail in general — which is what made a session appear
    // to rename itself the moment it stopped being live.
    expect(getConversationHistoryTitle(makeEntry())).toBe('Project Session');
  });

  it('re-derives from the first user message when no stored title exists', () => {
    expect(
      getConversationHistoryTitle(makeEntry({ displayName: '' }))
    ).toBe('Investigate prod error');
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
        makeEntry({ displayName: '', firstUserMessage: 'We need to harden UnstablePvP coin accounting' })
      )
    ).toBe('Harden UnstablePvP coin accounting');
  });

  it('falls back to the last user message when the first is blank', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          displayName: '',
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
          displayName: '',
          firstUserMessage: '  Plan   the   smoke   test  ',
        })
      )
    ).toBe('Plan the smoke test');
  });

  it('ignores a persisted AI title that is only unfinished <think> reasoning', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          displayName: '',
          aiTitle: '<think> Alright, I need to summarize this session.',
          firstUserMessage: 'Fix tab renaming titles',
        })
      )
    ).toBe('Fix tab renaming titles');
  });

  it('keeps the stored title when re-deriving would collapse to pure filler', () => {
    // Real drift: the live title was built from the attachment name, which the
    // history resolver cannot see. Re-deriving from the prose alone gave "Fix",
    // so the session appeared to rename itself the moment it stopped being live.
    expect(
      getConversationHistoryTitle(
        makeEntry({
          displayName: 'Pasted-image-9.png fix',
          firstUserMessage: 'Please fix this',
          lastUserMessage: '',
        })
      )
    ).toBe('Pasted-image-9.png fix');
  });

  it('titles from the first line only, matching the live instant title', () => {
    // Real drift: the live path took the first line, the history path front-loaded
    // the whole message, so a multi-line prompt rendered two different titles.
    expect(
      getConversationHistoryTitle(
        makeEntry({
          displayName: 'Read-only diagnostic.',
          firstUserMessage:
            'Read-only diagnostic.\nRun these and reply with ONLY the raw output in one code block, under 35 lines.',
        })
      )
    ).toBe('Read-only diagnostic');
  });

  it('never renders a generated title longer than the rail budget', () => {
    const title = getConversationHistoryTitle(
      makeEntry({
        aiTitle:
          'The tab title should summarize importing modules into a context worker with an '
          + 'error. It needs to be concise (3-6 words) and start with the most distinctive '
          + 'word. **Title:** Module Import Issue',
      })
    );
    expect(title.length).toBeLessThanOrEqual(MAX_FALLBACK_TITLE_LENGTH + 3);
  });

  it('never renders a first-message title longer than the rail budget', () => {
    const title = getConversationHistoryTitle(
      makeEntry({
        displayName: '',
        firstUserMessage:
          'Clrsoftware.co.uk Anything here we can steal for our website, it seems like '
          + "he's doing a very similar thing to what we want to build ourselves.",
      })
    );
    expect(title.length).toBeLessThanOrEqual(MAX_FALLBACK_TITLE_LENGTH + 3);
  });

  it('agrees with the live resolver for the same generated title', () => {
    const displayName = 'Read-only diagnostic.';
    const entry = makeEntry({
      displayName,
      firstUserMessage: 'Read-only diagnostic.\nRun these and reply with ONLY the raw output.',
    });
    expect(resolveEffectiveInstanceTitle({ displayName }, entry)).toBe(
      getConversationHistoryTitle(entry)
    );
  });

  it('keeps the truncation marker on a re-derived title (LT-534)', () => {
    // `truncateForRail` appends "..."; `sanitizeGeneratedTitle` strips trailing
    // ".!?". Whether the marker survived used to depend on which ran last, so one
    // long title rendered "…servers and..." live and "…servers and" in history.
    //
    // The load-bearing assertion here is `endsWith('...')`. The `live === hist`
    // check is true by construction — both resolvers now route through the same
    // `normalizeGeneratedHistoryTitlePart` — so it documents the shared path
    // rather than proving the fix; only the marker assertion discriminates it.
    // Exercised through the RE-DERIVATION path (no stored title), which is where
    // the sanitize/truncate ordering can still diverge. With a stored title
    // present the history resolver returns it verbatim, so this scenario would be
    // structurally unreachable and the test would prove nothing.
    const longMessage =
      'Daily health check of the Dingley Assessment servers and public demos. '
      + 'Work non-interactively and report back with anything that looks wrong.';
    const entry = makeEntry({ displayName: '', firstUserMessage: longMessage });
    const hist = getConversationHistoryTitle(entry);
    // The live rail, given that same derived title as its instance displayName,
    // must render it identically.
    const live = resolveEffectiveInstanceTitle({ displayName: hist }, entry);
    expect(live).toBe(hist);
    expect(hist.endsWith('...')).toBe(true);
  });

  it('preserves an already-truncated title only when asked to (LT-534)', () => {
    const truncated = truncateForRail('x'.repeat(20) + ' ' + 'y'.repeat(80));
    expect(truncated.endsWith('...')).toBe(true);
    expect(
      sanitizeGeneratedTitle(truncated, { preserveTruncationMarker: true })
    ).toBe(truncated);
  });

  it('does not dress up raw model output as truncated (LT-534)', () => {
    // A model that ignores "no trailing punctuation" and answers with a genuine
    // ellipsis must not be shown as though the rail had cut its title short.
    expect(sanitizeGeneratedTitle('Continuing the analysis...')).toBe('Continuing the analysis');
    expect(sanitizeGeneratedTitle('Fix the login bug.')).toBe('Fix the login bug');
    expect(sanitizeGeneratedTitle('Why does this fail?!')).toBe('Why does this fail');
  });

  it('lets re-derivation beat a stored title that is pure filler (LT-534b valve)', () => {
    // A restored session's name is a fixed point: restore computes it once, never
    // re-runs auto-titling, and writes it back on re-archival. Without this valve
    // a filler title would be locked in permanently and no future improvement to
    // derivation could reach it.
    expect(
      getConversationHistoryTitle(
        makeEntry({ displayName: 'Fix', firstUserMessage: 'Upgrade angular to version 22' })
      )
    ).toBe('Upgrade angular to version 22');
  });

  it('keeps a filler stored title when re-derivation is filler too (LT-534b valve)', () => {
    // Real data: stored "work" vs first message "hi". Swapping one useless title
    // for another is churn, and churn is the bug being fixed.
    expect(
      getConversationHistoryTitle(makeEntry({ displayName: 'work', firstUserMessage: 'hi' }))
    ).toBe('work');
  });

  it('strips closed <think> reasoning from a persisted AI title', () => {
    expect(
      getConversationHistoryTitle(
        makeEntry({
          aiTitle: '<think>Need a concise title.</think>\nTab rename sanitizer',
          firstUserMessage: 'Fix tab renaming titles',
        })
      )
    ).toBe('Tab rename sanitizer');
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
        makeEntry({ displayName: '', firstUserMessage: 'Investigate prod error' })
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

  it('does not display unfinished <think> reasoning from an auto-generated live displayName', () => {
    expect(
      resolveEffectiveInstanceTitle(
        { displayName: '<think> Okay, I need to summarize this session.', isRenamed: false },
        makeEntry({ displayName: '', firstUserMessage: 'Fix tab renaming titles' })
      )
    ).toBe('Fix tab renaming titles');
  });

  it('preserves a user-renamed displayName even if it contains literal <think> text', () => {
    expect(
      resolveEffectiveInstanceTitle(
        { displayName: '<think> literal docs note', isRenamed: true },
        makeEntry({ firstUserMessage: 'Fix tab renaming titles' })
      )
    ).toBe('<think> literal docs note');
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
