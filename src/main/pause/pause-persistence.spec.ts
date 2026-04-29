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

import { PausePersistence } from './pause-persistence';

describe('PausePersistence', () => {
  beforeEach(() => {
    mockBacking = {};
  });

  it('returns null when no state has been saved', () => {
    const persistence = new PausePersistence();

    expect(persistence.load()).toBeNull();
  });

  it('returns corrupted sentinel when stored data is malformed', () => {
    mockBacking['state'] = { reasons: 'not-an-array', persistedAt: 'oops' };
    const persistence = new PausePersistence();

    expect(persistence.load()).toBe('corrupted');
  });

  it('round-trips a valid state', () => {
    const persistence = new PausePersistence();

    persistence.save({ reasons: ['user'], persistedAt: 1000, recentTransitions: [] });

    expect(persistence.load()).toEqual({
      reasons: ['user'],
      persistedAt: 1000,
      recentTransitions: [],
    });
  });

  it('trims recentTransitions to last 20 on save', () => {
    const persistence = new PausePersistence();
    const recentTransitions = Array.from({ length: 30 }, (_, index) => ({
      at: index,
      from: [],
      to: ['vpn'] as const,
      trigger: `t${index}`,
    }));

    persistence.save({ reasons: [], persistedAt: 0, recentTransitions });

    const loaded = persistence.load();
    expect(loaded).not.toBeNull();
    expect(loaded).not.toBe('corrupted');
    if (loaded && loaded !== 'corrupted') {
      expect(loaded.recentTransitions).toHaveLength(20);
      expect(loaded.recentTransitions[0]?.at).toBe(10);
    }
  });
});
