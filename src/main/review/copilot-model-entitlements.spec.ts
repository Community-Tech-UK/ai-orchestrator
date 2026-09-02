import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCopilotEntitlementsForTesting,
  getCopilotEntitlements,
  isModelKnownUnavailable,
  learnFromCheckerFailure,
  parseCopilotUnavailableModelError,
  parseCopilotUnavailableModelFlag,
  recordCopilotEntitlements,
} from './copilot-model-entitlements';

/**
 * Verbatim shape of the refusal, as it appeared in the EBRD enterprise seat's
 * own `model_call_failure` event — JSON-escaped quotes and all. If the parser
 * stops recognising this exact string the policy silently loses its only
 * authoritative source of seat entitlements.
 */
const REAL_REFUSAL =
  '{"message":"The requested model is not available for integrator \\"copilot-developer-cli\\". ' +
  'Available models: [gpt-4.1 claude-fable-5 claude-opus-4.7 claude-opus-4.8-fast claude-opus-4.8 ' +
  'claude-opus-5 claude-sonnet-5 gemini-3.5-flash gpt-5.3-codex gpt-5.4 gpt-5.5 gpt-5.6-terra ' +
  'grok-4.6 kimi-k3 mai-code-1.1-flash]"}';

describe('parseCopilotUnavailableModelError', () => {
  beforeEach(() => {
    _resetCopilotEntitlementsForTesting();
  });

  it('extracts the integrator and roster from the real refusal', () => {
    const parsed = parseCopilotUnavailableModelError(REAL_REFUSAL);
    expect(parsed).not.toBeNull();
    expect(parsed?.integrator).toBe('copilot-developer-cli');
    expect(parsed?.availableModels).toContain('claude-opus-5');
    expect(parsed?.availableModels).toContain('gpt-5.6-terra');
    expect(parsed?.availableModels).toContain('grok-4.6');
    expect(parsed?.availableModels).toHaveLength(15);
  });

  it('parses an unescaped form too', () => {
    const parsed = parseCopilotUnavailableModelError(
      'The requested model is not available for integrator "copilot-developer-cli". ' +
        'Available models: [gpt-5.5 claude-opus-5]',
    );
    expect(parsed?.availableModels).toEqual(['gpt-5.5', 'claude-opus-5']);
  });

  it('tolerates a comma-separated roster', () => {
    const parsed = parseCopilotUnavailableModelError(
      'The requested model is not available for integrator "x". Available models: [a, b, c]',
    );
    expect(parsed?.availableModels).toEqual(['a', 'b', 'c']);
  });

  it('returns null for unrelated errors rather than poisoning the cache', () => {
    expect(parseCopilotUnavailableModelError('429 rate limit exceeded')).toBeNull();
    expect(parseCopilotUnavailableModelError('')).toBeNull();
    expect(parseCopilotUnavailableModelError(undefined)).toBeNull();
    // Right shape, no roster — must not be treated as "seat serves nothing".
    expect(
      parseCopilotUnavailableModelError(
        'The requested model is not available for integrator "x". Available models: []',
      ),
    ).toBeNull();
  });
});

describe('entitlement cache', () => {
  beforeEach(() => {
    _resetCopilotEntitlementsForTesting();
  });

  it('knows nothing until a seat refuses something', () => {
    expect(getCopilotEntitlements('lawrencj')).toBeNull();
    // Unknown seat constrains nothing — this is the load-bearing default.
    expect(isModelKnownUnavailable('lawrencj', 'claude-sonnet-4.6')).toBe(false);
  });

  it('records a roster per profile and keeps profiles independent', () => {
    recordCopilotEntitlements('lawrencj', ['claude-opus-5', 'gpt-5.6-terra']);

    expect(isModelKnownUnavailable('lawrencj', 'claude-opus-5')).toBe(false);
    expect(isModelKnownUnavailable('lawrencj', 'claude-sonnet-4.6')).toBe(true);
    // A different seat is still unlearned.
    expect(isModelKnownUnavailable('legacy', 'claude-sonnet-4.6')).toBe(false);
  });

  it('matches case-insensitively', () => {
    recordCopilotEntitlements('lawrencj', ['GPT-5.6-Terra']);
    expect(isModelKnownUnavailable('lawrencj', 'gpt-5.6-terra')).toBe(false);
  });

  it('ignores an empty roster', () => {
    recordCopilotEntitlements('lawrencj', ['  ', '']);
    expect(getCopilotEntitlements('lawrencj')).toBeNull();
  });
});

describe('entitlement staleness', () => {
  beforeEach(() => {
    _resetCopilotEntitlementsForTesting();
    vi.useRealTimers();
  });

  it('forgets a learned roster after its TTL so a seat that GAINS a model is not stuck', () => {
    vi.useFakeTimers();
    try {
      recordCopilotEntitlements('lawrencj', ['claude-opus-5']);
      expect(isModelKnownUnavailable('lawrencj', 'grok-4.6')).toBe(true);

      // A refusal only ever teaches "fewer models". Nothing refuses a model that
      // has just become available, so without expiry this stays wrong forever.
      vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);

      expect(getCopilotEntitlements('lawrencj')).toBeNull();
      expect(isModelKnownUnavailable('lawrencj', 'grok-4.6')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Measured live against the EBRD enterprise seat on 2026-09-02. `copilot`
 * validates `--model` against the account's real entitlements BEFORE sending, so
 * a non-entitled model produces this client-side error and never reaches the API
 * form. Recognising only the API form meant the common case taught the cache
 * nothing and the dead model was re-picked forever.
 */
describe('client-side flag refusal', () => {
  beforeEach(() => {
    _resetCopilotEntitlementsForTesting();
  });

  const REAL_FLAG_REFUSAL = 'Error: Model "grok-4.6" from --model flag is not available.';

  it('extracts the refused model id from the real message', () => {
    expect(parseCopilotUnavailableModelFlag(REAL_FLAG_REFUSAL)).toBe('grok-4.6');
  });

  it('returns null for unrelated text', () => {
    expect(parseCopilotUnavailableModelFlag('429 rate limit')).toBeNull();
    expect(parseCopilotUnavailableModelFlag(undefined)).toBeNull();
  });

  it('learns from it, so the model is not chosen again for that seat', () => {
    expect(isModelKnownUnavailable('lawrencj', 'grok-4.6')).toBe(false);

    learnFromCheckerFailure('lawrencj', REAL_FLAG_REFUSAL);

    expect(isModelKnownUnavailable('lawrencj', 'grok-4.6')).toBe(true);
    // One refusal says nothing about any other model, and must not be mistaken
    // for "the seat serves only this".
    expect(isModelKnownUnavailable('lawrencj', 'gpt-5.6-terra')).toBe(false);
    expect(isModelKnownUnavailable('other-seat', 'grok-4.6')).toBe(false);
  });
});

describe('flag-refusal staleness', () => {
  beforeEach(() => {
    _resetCopilotEntitlementsForTesting();
    vi.useRealTimers();
  });

  it('expires a single-model refusal on the same TTL as the roster', () => {
    // The client-side form is the COMMON case on a real seat, so leaving it
    // un-expiring would reopen the exact failure the roster TTL exists to
    // prevent: a seat that later gains the model keeps excluding it until the
    // process restarts.
    vi.useFakeTimers();
    try {
      learnFromCheckerFailure('lawrencj', 'Error: Model "grok-4.6" from --model flag is not available.');
      expect(isModelKnownUnavailable('lawrencj', 'grok-4.6')).toBe(true);

      vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);

      expect(isModelKnownUnavailable('lawrencj', 'grok-4.6')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
