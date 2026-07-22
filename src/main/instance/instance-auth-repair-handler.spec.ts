import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  AUTH_RECHECK_INTERVAL_MS,
  AUTH_WATCH_TIMEOUT_MS,
  InstanceAuthRepairHandler,
  getInstanceAuthRepairHandler,
  _resetInstanceAuthRepairHandlerForTesting,
} from './instance-auth-repair-handler';
import type { InstanceWaitReason } from '../../shared/types/instance.types';
import type { ProviderAuthState } from '../providers/provider-auth-status';

describe('InstanceAuthRepairHandler', () => {
  const waitReasons = new Map<string, InstanceWaitReason | null>();
  const resendInput = vi.fn();
  const revive = vi.fn(async (id: string) => id as string | null);
  const probeAuth = vi.fn(async (_provider: string) => 'unauthenticated' as ProviderAuthState);

  function configure(): InstanceAuthRepairHandler {
    const handler = getInstanceAuthRepairHandler();
    handler.configure({
      setWaitReason: (id, wr) => { waitReasons.set(id, wr); },
      revive,
      resendInput,
      probeAuth,
    });
    return handler;
  }

  async function block(handler: InstanceAuthRepairHandler, instanceId = 'i1') {
    return handler.maybeBlockOnAuth({
      instanceId,
      provider: 'claude',
      reason: 'provider auth failure on turn: OAuth session expired',
      resumePrompt: 'the lost turn',
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    waitReasons.clear();
    _resetInstanceAuthRepairHandlerForTesting();
    revive.mockImplementation(async (id: string) => id);
    probeAuth.mockResolvedValue('unauthenticated');
  });

  afterEach(() => {
    _resetInstanceAuthRepairHandlerForTesting();
    vi.useRealTimers();
  });

  it('blocks the instance and marks it auth-required when the probe confirms the sign-out', async () => {
    const handler = configure();

    await expect(block(handler)).resolves.toBe('blocked');

    expect(handler.isBlocked('i1')).toBe(true);
    expect(waitReasons.get('i1')).toMatchObject({ kind: 'auth-required', provider: 'claude' });
  });

  it('skips when the provider still reports authenticated (auth-shaped text, other cause)', async () => {
    // A tool or MCP error can carry OAuth wording; the live probe is the arbiter.
    probeAuth.mockResolvedValue('authenticated');
    const handler = configure();

    await expect(block(handler)).resolves.toBe('skipped');

    expect(handler.isBlocked('i1')).toBe(false);
    expect(waitReasons.has('i1')).toBe(false);
  });

  it('still blocks when the probe cannot run — an unreadable probe is not proof of health', async () => {
    probeAuth.mockResolvedValue('unknown');
    const handler = configure();

    await expect(block(handler)).resolves.toBe('blocked');
  });

  it('keeps the first lost turn when a second failure arrives', async () => {
    const handler = configure();
    await block(handler);

    const second = await handler.maybeBlockOnAuth({
      instanceId: 'i1',
      provider: 'claude',
      reason: 'another auth failure',
      resumePrompt: 'a later turn',
    });

    expect(second).toBe('already-blocked');
    probeAuth.mockResolvedValue('authenticated');
    await handler.retryNow('i1');
    expect(resendInput).toHaveBeenCalledWith('i1', 'the lost turn');
  });

  it('auto-resumes when the user signs back in: revive, then re-send the lost turn', async () => {
    const handler = configure();
    await block(handler);
    expect(resendInput).not.toHaveBeenCalled();

    probeAuth.mockResolvedValue('authenticated');
    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS + 1);

    expect(revive).toHaveBeenCalledWith('i1');
    expect(resendInput).toHaveBeenCalledWith('i1', 'the lost turn');
    expect(waitReasons.get('i1')).toBeNull();
    expect(handler.isBlocked('i1')).toBe(false);
  });

  it('re-sends to the id revival returned, not the dead one', async () => {
    // History restore can land the thread on a new instance id.
    revive.mockResolvedValue('i1-restored');
    const handler = configure();
    await block(handler);

    probeAuth.mockResolvedValue('authenticated');
    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS + 1);

    expect(resendInput).toHaveBeenCalledWith('i1-restored', 'the lost turn');
  });

  it('keeps the banner when revival fails, instead of dropping the turn silently', async () => {
    revive.mockResolvedValue(null);
    const handler = configure();
    await block(handler);

    probeAuth.mockResolvedValue('authenticated');
    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS + 1);

    expect(resendInput).not.toHaveBeenCalled();
    // The user must keep a lever: clearing the block here would leave a dead
    // session, no banner, and a silently lost turn.
    expect(handler.isBlocked('i1')).toBe(true);
    expect(waitReasons.get('i1')).toMatchObject({ kind: 'auth-required' });
  });

  it('recovers on a later poll when revival succeeds the second time', async () => {
    revive.mockResolvedValueOnce(null);
    const handler = configure();
    await block(handler);
    probeAuth.mockResolvedValue('authenticated');

    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS + 1);
    expect(resendInput).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS + 1);
    expect(resendInput).toHaveBeenCalledWith('i1', 'the lost turn');
    expect(handler.isBlocked('i1')).toBe(false);
  });

  it('does not claim a manual retry resumed when revival failed', async () => {
    revive.mockResolvedValue(null);
    const handler = configure();
    await block(handler);
    probeAuth.mockResolvedValue('authenticated');

    const outcome = await handler.retryNow('i1');

    expect(outcome.status).toBe('unknown');
    expect(handler.isBlocked('i1')).toBe(true);
  });

  it('keeps polling while still signed out, without re-sending', async () => {
    const handler = configure();
    await block(handler);

    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS * 3 + 1);

    expect(resendInput).not.toHaveBeenCalled();
    expect(handler.isBlocked('i1')).toBe(true);
    expect(probeAuth.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops polling after the watch timeout but keeps the instance blocked for manual retry', async () => {
    const handler = configure();
    await block(handler);

    await vi.advanceTimersByTimeAsync(AUTH_WATCH_TIMEOUT_MS + AUTH_RECHECK_INTERVAL_MS);
    const callsAtTimeout = probeAuth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS * 5);

    expect(probeAuth.mock.calls.length).toBe(callsAtTimeout);
    expect(handler.isBlocked('i1')).toBe(true);

    // The manual path still works after the watcher gives up.
    probeAuth.mockResolvedValue('authenticated');
    await expect(handler.retryNow('i1')).resolves.toEqual({ status: 'resumed' });
    expect(resendInput).toHaveBeenCalledWith('i1', 'the lost turn');
  });

  it('reports still-signed-out from a manual retry instead of silently doing nothing', async () => {
    const handler = configure();
    await block(handler);

    await expect(handler.retryNow('i1')).resolves.toEqual({ status: 'still-signed-out' });
    expect(resendInput).not.toHaveBeenCalled();
  });

  it('reports an unreadable probe distinctly from a confirmed sign-out', async () => {
    const handler = configure();
    await block(handler);
    probeAuth.mockResolvedValue('unknown');

    const outcome = await handler.retryNow('i1');

    expect(outcome.status).toBe('unknown');
  });

  it('reports not-blocked for an instance with no auth block', async () => {
    const handler = configure();
    await expect(handler.retryNow('nope')).resolves.toEqual({ status: 'not-blocked' });
  });

  it('cancel clears the waitReason and stops the watcher', async () => {
    const handler = configure();
    await block(handler);

    expect(handler.cancel('i1')).toBe(true);
    expect(waitReasons.get('i1')).toBeNull();
    expect(handler.isBlocked('i1')).toBe(false);

    probeAuth.mockClear();
    probeAuth.mockResolvedValue('authenticated');
    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS * 3);
    expect(probeAuth).not.toHaveBeenCalled();
    expect(resendInput).not.toHaveBeenCalled();
  });

  it('forget releases the polling interval on termination', async () => {
    const handler = configure();
    await block(handler);

    handler.forget('i1');

    probeAuth.mockClear();
    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS * 3);
    expect(probeAuth).not.toHaveBeenCalled();
  });

  it('does not watch providers that cannot be probed, but still shows the banner', async () => {
    const handler = configure();

    const outcome = await handler.maybeBlockOnAuth({
      instanceId: 'i2',
      provider: 'copilot',
      reason: 'auth failure',
      resumePrompt: 'lost turn',
    });

    expect(outcome).toBe('blocked');
    expect(waitReasons.get('i2')).toMatchObject({ kind: 'auth-required', provider: 'copilot' });
    // No probe exists for copilot, so nothing is polled — the banner is manual only.
    probeAuth.mockClear();
    await vi.advanceTimersByTimeAsync(AUTH_RECHECK_INTERVAL_MS * 3);
    expect(probeAuth).not.toHaveBeenCalled();
  });

  it('is inert until configured', async () => {
    _resetInstanceAuthRepairHandlerForTesting();
    const handler = getInstanceAuthRepairHandler();

    await expect(block(handler)).resolves.toBe('skipped');
  });
});
