import { describe, it, expect } from 'vitest';
import {
  evaluateSpawn,
  DEFAULT_MAX_SPAWN_DEPTH,
} from './subagent-spawn-guard';

describe('subagent-spawn-guard / evaluateSpawn', () => {
  describe('depth rail', () => {
    it('allows a root agent (depth 0) to spawn a depth-1 child', () => {
      const d = evaluateSpawn({ parentDepth: 0, limits: { maxDepth: 3 } });
      expect(d.allowed).toBe(true);
      expect(d.childDepth).toBe(1);
      expect(d.reason).toBeUndefined();
    });

    it('allows spawning right up to the depth limit', () => {
      // parent at depth 2 → child at depth 3 == maxDepth → allowed
      const d = evaluateSpawn({ parentDepth: 2, limits: { maxDepth: 3 } });
      expect(d.allowed).toBe(true);
      expect(d.childDepth).toBe(3);
    });

    it('blocks spawning past the depth limit and still reports childDepth', () => {
      // parent at depth 3 → child at depth 4 > maxDepth 3 → blocked
      const d = evaluateSpawn({ parentDepth: 3, limits: { maxDepth: 3 } });
      expect(d.allowed).toBe(false);
      expect(d.childDepth).toBe(4);
      expect(d.reason).toMatch(/depth 4 exceeds the maximum allowed depth of 3/);
      expect(d.reason).toMatch(/recursion guard/);
    });

    it('treats maxDepth <= 0 as unbounded', () => {
      for (const maxDepth of [0, -1]) {
        const d = evaluateSpawn({ parentDepth: 1000, limits: { maxDepth } });
        expect(d.allowed).toBe(true);
        expect(d.childDepth).toBe(1001);
      }
    });

    it('clamps non-finite / negative / fractional parent depth to a sane child depth', () => {
      expect(evaluateSpawn({ parentDepth: -5, limits: { maxDepth: 3 } }).childDepth).toBe(1);
      expect(evaluateSpawn({ parentDepth: Number.NaN, limits: { maxDepth: 3 } }).childDepth).toBe(1);
      expect(evaluateSpawn({ parentDepth: 1.9, limits: { maxDepth: 3 } }).childDepth).toBe(2);
    });
  });

  describe('concurrency rail', () => {
    it('blocks when active children have reached the concurrent ceiling', () => {
      const d = evaluateSpawn({
        parentDepth: 0,
        activeChildCount: 5,
        limits: { maxDepth: 10, maxConcurrentChildren: 5 },
      });
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/active spawned-child count \(5\) has reached the maximum of 5/);
    });

    it('allows when below the concurrent ceiling', () => {
      const d = evaluateSpawn({
        parentDepth: 0,
        activeChildCount: 4,
        limits: { maxDepth: 10, maxConcurrentChildren: 5 },
      });
      expect(d.allowed).toBe(true);
    });

    it('skips the concurrency rail when activeChildCount is omitted', () => {
      const d = evaluateSpawn({
        parentDepth: 0,
        limits: { maxDepth: 10, maxConcurrentChildren: 1 },
      });
      expect(d.allowed).toBe(true);
    });

    it('treats maxConcurrentChildren <= 0 / undefined as unbounded', () => {
      expect(
        evaluateSpawn({
          parentDepth: 0,
          activeChildCount: 9999,
          limits: { maxDepth: 10, maxConcurrentChildren: 0 },
        }).allowed,
      ).toBe(true);
      expect(
        evaluateSpawn({
          parentDepth: 0,
          activeChildCount: 9999,
          limits: { maxDepth: 10 },
        }).allowed,
      ).toBe(true);
    });
  });

  describe('rail ordering', () => {
    it('reports the depth violation first when both rails are exceeded', () => {
      const d = evaluateSpawn({
        parentDepth: 5,
        activeChildCount: 100,
        limits: { maxDepth: 3, maxConcurrentChildren: 5 },
      });
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/depth/);
    });
  });

  it('exposes a sane default max depth', () => {
    expect(DEFAULT_MAX_SPAWN_DEPTH).toBeGreaterThan(0);
    // A lead → worker → sub-worker chain (depth 3) must be permitted by default.
    expect(
      evaluateSpawn({ parentDepth: 2, limits: { maxDepth: DEFAULT_MAX_SPAWN_DEPTH } }).allowed,
    ).toBe(true);
  });
});
