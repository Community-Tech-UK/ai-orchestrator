import { describe, expect, it } from 'vitest';
import {
  LARGE_REPLAY_DROPPED_TOKENS,
  LARGE_RESEND_TOKENS,
  describeRuntimeChangeCost,
  runtimeChangeKind,
  type RuntimeChangeFlags,
} from './runtime-change-cost';
import { formatApproxTokens } from './claude-cache-economics';
import { REPLAY_DIGEST_MAX_TOKENS, replayCarryover } from './replay-carryover';

const none: RuntimeChangeFlags = {
  providerChanged: false, modelChanged: false, reasoningChanged: false, runtimeTargetChanged: false,
  yoloModeChanged: false, copilotAccountChanged: false, accountProfileChanged: false,
};
const flags = (patch: Partial<RuntimeChangeFlags>): RuntimeChangeFlags => ({ ...none, ...patch });

describe('runtimeChangeKind', () => {
  it('names nothing when nothing changes', () => {
    expect(runtimeChangeKind(none)).toBeNull();
  });

  it('lets the biggest change decide the wording', () => {
    expect(runtimeChangeKind(flags({ providerChanged: true, modelChanged: true, reasoningChanged: true }))).toBe('provider');
    expect(runtimeChangeKind(flags({ runtimeTargetChanged: true, modelChanged: true }))).toBe('local-model');
    expect(runtimeChangeKind(flags({ copilotAccountChanged: true, modelChanged: true }))).toBe('copilot-account');
    expect(runtimeChangeKind(flags({ modelChanged: true, reasoningChanged: true }))).toBe('model');
    expect(runtimeChangeKind(flags({ accountProfileChanged: true, yoloModeChanged: true }))).toBe('account');
    expect(runtimeChangeKind(flags({ reasoningChanged: true, yoloModeChanged: true }))).toBe('reasoning');
    expect(runtimeChangeKind(flags({ yoloModeChanged: true }))).toBe('auto-approve');
  });
});

describe('replay: a new session gets a short summary', () => {
  const replay = { continuity: 'replay' as const };

  it('says what carries over, sized against the target window', () => {
    const note = describeRuntimeChangeCost(flags({ modelChanged: true }), 230_000, true, {
      ...replay, targetWindowTokens: 200_000, targetLabel: 'Claude',
    });
    expect(note).toMatchObject({ kind: 'model', large: true, resendTokens: null, carriedTokens: REPLAY_DIGEST_MAX_TOKENS });
    expect(note?.droppedTokens).toBe(230_000 - REPLAY_DIGEST_MAX_TOKENS);
    expect(note?.text).toBe(
      'Switching model starts a new session with a short summary of this one '
      + `(your first request, the last 24 messages and open to-dos: about ${formatApproxTokens(REPLAY_DIGEST_MAX_TOKENS)} of the 230K tokens here, 4% of Claude's 200K window); `
      + 'the rest does not carry over.',
    );
  });

  it('waits for a running reply to finish', () => {
    const note = describeRuntimeChangeCost(flags({ modelChanged: true }), 230_000, false, replay);
    expect(note?.text.startsWith('Once the current reply finishes, switching model starts a new session')).toBe(true);
  });

  it('warns even below the digest budget because replay can truncate individual messages', () => {
    const note = describeRuntimeChangeCost(flags({ modelChanged: true }), 2_000, true, replay);
    expect(note?.text).toContain('the rest does not carry over');
    expect(note?.large).toBe(false);
  });

  it('warns when the summary would not fit a small window, and states tiny shares plainly', () => {
    const tight = describeRuntimeChangeCost(flags({ runtimeTargetChanged: true }), 230_000, true, {
      ...replay, targetWindowTokens: 8_192, targetLabel: 'the local model',
    });
    expect(tight?.text).toContain('which may not fit the local model\'s 8K window');
    const huge = describeRuntimeChangeCost(flags({ providerChanged: true }), 230_000, true, {
      ...replay, targetWindowTokens: 2_000_000, targetLabel: 'Gemini',
    });
    expect(huge?.text).toContain("under 1% of Gemini's 2M window");
  });

  it('keeps the replay warning even when total size fits the summary budget', () => {
    for (const size of [REPLAY_DIGEST_MAX_TOKENS, 3_000]) {
      expect(describeRuntimeChangeCost(flags({ modelChanged: true }), size, true, replay))
        .toMatchObject({ large: false, resendTokens: null, droppedTokens: 0 });
    }
  });

  it('still says what the summary is when the session size is not known', () => {
    const note = describeRuntimeChangeCost(flags({ reasoningChanged: true }), null, true, replay);
    expect(note?.text).toBe(
      'Changing thinking effort starts a new session with a short summary of this one '
      + '(your first request, the last 24 messages and open to-dos); the rest does not carry over.',
    );
    expect(note).toMatchObject({ carriedTokens: null, droppedTokens: null, large: false });
  });

  describe('asking first', () => {
    const askedAbout = (contextTokens: number | null) =>
      describeRuntimeChangeCost(flags({ providerChanged: true }), contextTokens, true, replay)?.large;

    it('asks when a large part of the conversation would be left behind, because that cannot be undone', () => {
      expect(askedAbout(900_000)).toBe(true);
    });

    it('draws the line on what is left behind, not on the size of the session', () => {
      expect(askedAbout(REPLAY_DIGEST_MAX_TOKENS + LARGE_REPLAY_DROPPED_TOKENS - 1)).toBe(false);
      expect(askedAbout(REPLAY_DIGEST_MAX_TOKENS + LARGE_REPLAY_DROPPED_TOKENS)).toBe(true);
    });

    it('does not ask about a modest session, even though something is left behind', () => {
      expect(askedAbout(60_000)).toBe(false);
    });

    it('does not ask when the size is not known, since nothing can be said about how much is lost', () => {
      expect(askedAbout(null)).toBe(false);
    });

    it('never claims a bill: the re-send is only the summary', () => {
      expect(describeRuntimeChangeCost(flags({ providerChanged: true }), 900_000, true, replay)?.resendTokens).toBeNull();
    });
  });
});

describe('native resume: the conversation is read again', () => {
  const native = { continuity: 'native-resume' as const };

  it('states the re-read and asks first when it is large', () => {
    const note = describeRuntimeChangeCost(flags({ modelChanged: true }), 230_000, true, native);
    expect(note).toEqual({
      kind: 'model',
      text: 'Switching model restarts this session, and the next message will re-read about 230K tokens at full price.',
      resendTokens: 230_000, carriedTokens: null, droppedTokens: null, large: true,
    });
  });

  it('draws the line at 100K', () => {
    expect(describeRuntimeChangeCost(flags({ modelChanged: true }), LARGE_RESEND_TOKENS - 1, true, native)?.large).toBe(false);
    expect(describeRuntimeChangeCost(flags({ modelChanged: true }), LARGE_RESEND_TOKENS, true, native)?.large).toBe(true);
  });

  it('covers an account switch and a running reply', () => {
    const note = describeRuntimeChangeCost(flags({ accountProfileChanged: true }), 150_000, false, { continuity: 'native-resume-fork' });
    expect(note?.text).toBe('Once the current reply finishes, switching account restarts this session, and the next message will re-read about 150K tokens at full price.');
    expect(note?.large).toBe(true);
  });

  it('says nothing for changes that resume with their cache intact', () => {
    expect(describeRuntimeChangeCost(flags({ yoloModeChanged: true }), 230_000, true, native)).toBeNull();
    expect(describeRuntimeChangeCost(flags({ reasoningChanged: true }), 230_000, true, native)).toBeNull();
  });

  it('says nothing when the cache has already expired or the size is not known', () => {
    expect(describeRuntimeChangeCost(flags({ modelChanged: true }), 230_000, true, { ...native, cacheWarm: false })).toBeNull();
    expect(describeRuntimeChangeCost(flags({ modelChanged: true }), null, true, native)).toBeNull();
    expect(describeRuntimeChangeCost(none, 230_000, true, native)).toBeNull();
  });
});

describe('replayCarryover', () => {
  it('carries the whole of a small conversation and a bounded digest of a large one', () => {
    expect(replayCarryover(2_000)).toEqual({ carriedTokens: 2_000, droppedTokens: 0 });
    expect(replayCarryover(230_000)).toEqual({ carriedTokens: REPLAY_DIGEST_MAX_TOKENS, droppedTokens: 230_000 - REPLAY_DIGEST_MAX_TOKENS });
    expect(replayCarryover(-5)).toEqual({ carriedTokens: 0, droppedTokens: 0 });
  });
});
