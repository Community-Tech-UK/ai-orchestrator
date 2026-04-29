import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockBacking: Record<string, unknown> = {};

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get store() {
      return mockBacking;
    },
    set: (key: string, value: unknown) => {
      mockBacking[key] = value;
    },
    clear: () => {
      mockBacking = {};
    },
  })),
}));

import { PauseCoordinator } from './pause-coordinator';

describe('PauseCoordinator', () => {
  beforeEach(() => {
    mockBacking = {};
    PauseCoordinator._resetForTesting();
  });

  it('starts running when persistence is empty', () => {
    const coordinator = PauseCoordinator.getInstance();
    coordinator.bootstrap();

    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.getState().reasons.size).toBe(0);
  });

  it('addReason transitions to paused', () => {
    const coordinator = PauseCoordinator.getInstance();

    coordinator.addReason('vpn');

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getState().reasons.has('vpn')).toBe(true);
  });

  it('multiple reasons act as refcount', () => {
    const coordinator = PauseCoordinator.getInstance();

    coordinator.addReason('vpn');
    coordinator.addReason('user');
    coordinator.removeReason('vpn');

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getState().reasons.has('user')).toBe(true);

    coordinator.removeReason('user');

    expect(coordinator.isPaused()).toBe(false);
  });

  it('emits pause on first reason and resume only after last reason', () => {
    const coordinator = PauseCoordinator.getInstance();
    const onPause = vi.fn();
    const onResume = vi.fn();
    coordinator.on('pause', onPause);
    coordinator.on('resume', onResume);

    coordinator.addReason('vpn');
    coordinator.addReason('user');
    coordinator.removeReason('vpn');
    coordinator.removeReason('user');

    expect(onPause).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('addReason and removeReason are idempotent', () => {
    const coordinator = PauseCoordinator.getInstance();
    const onPause = vi.fn();
    coordinator.on('pause', onPause);

    coordinator.addReason('vpn');
    coordinator.addReason('vpn');
    coordinator.removeReason('user');

    expect(coordinator.isPaused()).toBe(true);
    expect(onPause).toHaveBeenCalledOnce();
  });

  it('starts paused with user reason when persistence had user', () => {
    mockBacking['state'] = {
      reasons: ['user'],
      persistedAt: Date.now(),
      recentTransitions: [],
    };

    const coordinator = PauseCoordinator.getInstance();
    coordinator.bootstrap();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getState().reasons.has('user')).toBe(true);
    expect(coordinator.needsFirstScanForceVpnTreatment()).toBe(false);
  });

  it('starts paused with detector-error and force flag when persistence had vpn', () => {
    mockBacking['state'] = {
      reasons: ['vpn'],
      persistedAt: Date.now(),
      recentTransitions: [],
    };

    const coordinator = PauseCoordinator.getInstance();
    coordinator.bootstrap();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getState().reasons.has('detector-error')).toBe(true);
    expect(coordinator.getState().reasons.has('vpn')).toBe(false);
    expect(coordinator.needsFirstScanForceVpnTreatment()).toBe(true);
  });

  it('starts paused with detector-error when persistence is corrupted', () => {
    mockBacking['state'] = { reasons: 'malformed', persistedAt: 'oops' };

    const coordinator = PauseCoordinator.getInstance();
    coordinator.bootstrap();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getState().reasons.has('detector-error')).toBe(true);
    expect(coordinator.needsFirstScanForceVpnTreatment()).toBe(true);
  });

  it('reconciles fail-closed detector-error after first clean evaluation', () => {
    mockBacking['state'] = {
      reasons: ['vpn'],
      persistedAt: Date.now(),
      recentTransitions: [],
    };
    const coordinator = PauseCoordinator.getInstance();
    coordinator.bootstrap();

    coordinator.reconcileFirstEvaluation(false);

    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.getState().reasons.has('detector-error')).toBe(false);
  });

  it('reconciles fail-closed detector-error to vpn after first active evaluation', () => {
    mockBacking['state'] = {
      reasons: ['vpn'],
      persistedAt: Date.now(),
      recentTransitions: [],
    };
    const coordinator = PauseCoordinator.getInstance();
    coordinator.bootstrap();

    coordinator.reconcileFirstEvaluation(true);

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getState().reasons.has('detector-error')).toBe(false);
    expect(coordinator.getState().reasons.has('vpn')).toBe(true);
  });

  it('persists reasons on every change', () => {
    const coordinator = PauseCoordinator.getInstance();
    coordinator.bootstrap();

    coordinator.addReason('user');

    expect(mockBacking['state']).toBeDefined();
    const stored = mockBacking['state'] as { reasons: string[] };
    expect(stored.reasons).toEqual(['user']);
  });

  it('clears persisted state even before bootstrap has loaded it', () => {
    mockBacking['state'] = {
      reasons: ['vpn'],
      persistedAt: Date.now(),
      recentTransitions: [],
    };

    const coordinator = PauseCoordinator.getInstance();
    coordinator.clearAllReasons('feature-disabled');
    coordinator.bootstrap();

    expect(mockBacking['state']).toBeUndefined();
    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.getState().reasons.size).toBe(0);
  });
});
