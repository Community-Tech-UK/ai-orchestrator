import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { isAcpProviderLimitMessage, parseAcpLimitResetIn, tagAcpProviderLimit } from './acp-provider-limit';
import { detectErrorProviderLimit } from '../../instance/instance-provider-limit-detection';
import { detectAuthFailureSignal } from '../../instance/instance-auth-failure-detection';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

/** Error texts as the adapter builds them from OpenCode's JSON-RPC errors (Task 0.5 / retry.ts). */
const RATE_LIMITED = 'ACP session/prompt failed: Internal error: Rate Limited (-32603)';
const GO_LIMIT = 'ACP session/prompt failed: Internal error: Go usage limit reached. It will reset in 3 hours 20 minutes, To continue using this model now, enable usage from your available balance (-32603)';
const INVALID_KEY = 'ACP session/prompt failed: Internal error: Invalid API Key (-32603)';
const AUTH_REQUIRED = 'ACP session/prompt failed: provider authentication required (-32000)';

/** MiMo Token Plan shapes captured in the 2026-10-10 Phase 0.1 probe (placeholder bodies). */
const MIMO_RATE_TEXT = 'ACP session/prompt failed: Internal error: Rate limit reached for requests (-32603)';
const MIMO_429 = 'ACP session/prompt failed: Internal error: 429 Too Many Requests (-32603)';
const MIMO_PLAN_EXHAUSTED = 'ACP session/prompt failed: Internal error: Token Plan quota exhausted for this account. Renew the plan to continue. (-32603)';
const MIMO_QUOTA_400 = 'ACP session/prompt failed: Internal error: You have exceeded your token plan quota for mimo-v2.6-pro (-32603)';
const MIMO_INSUFFICIENT = 'ACP session/prompt failed: Internal error: Insufficient Balance (-32603)';
/** Phase 0.1 negatives: auth, 5xx, connection and stream breaks are never limits. */
const MIMO_SERVER_500 = 'ACP session/prompt failed: Internal error: Internal server error (-32603)';
const MIMO_BAD_KEY = 'ACP session/prompt failed: Internal error: Invalid API Key provided (-32603)';
const STREAM_BROKE = 'stream broke: Internal server error';
const CONNECTION_REFUSED = 'connect ECONNREFUSED 127.0.0.1:8971';

describe('acp provider limit tagging', () => {
  it('recognises OpenCode limit texts and nothing else', () => {
    expect(isAcpProviderLimitMessage(RATE_LIMITED)).toBe(true);
    expect(isAcpProviderLimitMessage(GO_LIMIT)).toBe(true);
    expect(isAcpProviderLimitMessage('Internal error: Too Many Requests')).toBe(true);
    expect(isAcpProviderLimitMessage('Internal error: Rate increased too quickly')).toBe(true);
    expect(isAcpProviderLimitMessage(INVALID_KEY)).toBe(false);
    expect(isAcpProviderLimitMessage('ACP prompt turn was cancelled by the client.')).toBe(false);
    // Capacity, not quota: deliberately not parked (see LIMIT_PATTERNS).
    expect(isAcpProviderLimitMessage('Provider is overloaded')).toBe(false);
  });

  it('recognises the MiMo Token Plan limit shapes from the probe (429 and plan/quota 4xx)', () => {
    expect(isAcpProviderLimitMessage(MIMO_RATE_TEXT)).toBe(true);
    expect(isAcpProviderLimitMessage(MIMO_429)).toBe(true);
    expect(isAcpProviderLimitMessage(MIMO_PLAN_EXHAUSTED)).toBe(true);
    expect(isAcpProviderLimitMessage(MIMO_QUOTA_400)).toBe(true);
    expect(isAcpProviderLimitMessage(MIMO_INSUFFICIENT)).toBe(true);
  });

  it('never counts MiMo auth errors, 500s, connection errors or stream breaks as limits', () => {
    expect(isAcpProviderLimitMessage(MIMO_BAD_KEY)).toBe(false);
    expect(isAcpProviderLimitMessage(MIMO_SERVER_500)).toBe(false);
    expect(isAcpProviderLimitMessage(STREAM_BROKE)).toBe(false);
    expect(isAcpProviderLimitMessage(CONNECTION_REFUSED)).toBe(false);
    for (const message of [MIMO_BAD_KEY, MIMO_SERVER_500, STREAM_BROKE, CONNECTION_REFUSED]) {
      const tagged = tagAcpProviderLimit(new Error(message), NOW);
      expect((tagged as Error & { quota?: unknown }).quota, message).toBeUndefined();
      expect(detectErrorProviderLimit(tagged, tagged.message), message).toBeNull();
    }
  });

  it('feeds MiMo limit texts into detectErrorProviderLimit as parked quota', () => {
    for (const message of [MIMO_RATE_TEXT, MIMO_429, MIMO_PLAN_EXHAUSTED, MIMO_QUOTA_400]) {
      const tagged = tagAcpProviderLimit(new Error(message), NOW);
      expect((tagged as Error & { quota?: { exhausted?: boolean } }).quota?.exhausted, message).toBe(true);
      // No reset text in the MiMo shapes: the park uses the assumed window.
      expect(detectErrorProviderLimit(tagged, tagged.message)?.resetAtHint ?? null, message).toBeNull();
    }
  });

  it('parses OpenCode reset durations', () => {
    expect(parseAcpLimitResetIn(GO_LIMIT, NOW)).toBe(NOW + (3 * 60 + 20) * 60_000);
    expect(parseAcpLimitResetIn('It will reset in 1 day 2 hours', NOW)).toBe(NOW + 26 * 3_600_000);
    expect(parseAcpLimitResetIn('It will reset in less than a minute', NOW)).toBeUndefined();
    expect(parseAcpLimitResetIn(RATE_LIMITED, NOW)).toBeUndefined();
  });

  it('turns a limit failure into a parked provider-limit turn, with the reset hint', () => {
    const tagged = tagAcpProviderLimit(new Error(GO_LIMIT), NOW);
    const signal = detectErrorProviderLimit(tagged, tagged.message);
    expect(signal?.resetAtHint).toBe(NOW + (3 * 60 + 20) * 60_000);

    const rateLimited = tagAcpProviderLimit(new Error(RATE_LIMITED), NOW);
    expect(detectErrorProviderLimit(rateLimited, rateLimited.message)).not.toBeNull();
  });

  it('leaves other failures untouched', () => {
    const error = tagAcpProviderLimit(new Error(INVALID_KEY), NOW);
    expect((error as Error & { quota?: unknown }).quota).toBeUndefined();
    expect(detectErrorProviderLimit(error, error.message)).toBeNull();
  });
});

describe('OpenCode auth failures', () => {
  it('reads as a provider sign-out, not a limit', () => {
    expect(detectAuthFailureSignal(INVALID_KEY)).not.toBeNull();
    expect(detectAuthFailureSignal(AUTH_REQUIRED)).not.toBeNull();
    expect(detectAuthFailureSignal('Run `opencode auth login` to connect a provider')).not.toBeNull();
  });
});

describe('AcpCliAdapter prompt failures', () => {
  it('emits a tagged limit error when OpenCode gives up on a rate limit', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (message) => proc.respondError(message.id, -32603, 'Internal error: Rate Limited'));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const errors: Error[] = [];
    adapter.on('error', (error: Error) => errors.push(error));
    await adapter.spawn();

    await adapter.sendInput('hello');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(RATE_LIMITED);
    expect((errors[0] as Error & { quota?: { exhausted?: boolean } }).quota?.exhausted).toBe(true);
    proc.exit();
  });

  it('emits the auth failure OpenCode reports for a bad key, untagged', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (message) => proc.respondError(message.id, -32603, 'Internal error: Invalid API Key'));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const errors: Error[] = [];
    adapter.on('error', (error: Error) => errors.push(error));
    await adapter.spawn();

    await adapter.sendInput('hello');

    expect(errors[0]?.message).toBe(INVALID_KEY);
    expect((errors[0] as Error & { quota?: unknown }).quota).toBeUndefined();
    expect(detectAuthFailureSignal(errors[0]!.message)).not.toBeNull();
    proc.exit();
  });
});
