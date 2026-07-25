import { describe, expect, it } from 'vitest';
import {
  getModelSwitchUnavailableReason,
  isModelSwitchAllowedStatus,
} from './instance-status-policy';
import type { InstanceStatus } from './instance.types';

describe('isModelSwitchAllowedStatus', () => {
  it.each(['idle', 'ready', 'waiting_for_input'] as const)('allows %s', (status) => {
    expect(isModelSwitchAllowedStatus(status)).toBe(true);
  });

  it('allows error so a dead provider can be swapped away from', () => {
    // Regression: a Codex session that 503'd sat in `error`, and a swap to
    // Claude could only queue. Nothing clears `error` except a successful
    // restart of the provider that was already failing, so the queued swap
    // never applied. `error` is a settled status (no live turn) and the change
    // terminates and respawns the adapter anyway.
    expect(isModelSwitchAllowedStatus('error')).toBe(true);
    expect(getModelSwitchUnavailableReason('error')).toBeUndefined();
  });

  it.each([
    'busy',
    'processing',
    'thinking_deeply',
    'waiting_for_permission',
    'interrupting',
    'cancelling',
    'respawning',
    'initializing',
  ] as const)('still refuses %s so a live or in-flight turn is never torn down', (status) => {
    expect(isModelSwitchAllowedStatus(status)).toBe(false);
    expect(getModelSwitchUnavailableReason(status)).toContain(status);
  });

  it.each(['failed', 'terminated'] as const)(
    'refuses the terminal status %s (no legal transition out)',
    (status) => {
      expect(isModelSwitchAllowedStatus(status)).toBe(false);
    },
  );

  it('reports a distinct reason when there is no live session', () => {
    expect(getModelSwitchUnavailableReason(undefined)).toBe(
      'Model changes require a selected live session.',
    );
    expect(isModelSwitchAllowedStatus(undefined as InstanceStatus | undefined)).toBe(false);
  });
});
