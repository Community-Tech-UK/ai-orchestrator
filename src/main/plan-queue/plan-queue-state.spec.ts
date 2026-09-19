import { describe, expect, it } from 'vitest';
import { PlanQueueItemStateSchema, type PlanQueueItemState } from '@contracts/schemas/plan-queue';
import {
  assertItemTransition,
  canTransitionItem,
  isTerminalItemState,
  itemHoldsWorktree,
} from './plan-queue-state';

const ALL_STATES = PlanQueueItemStateSchema.options;

describe('plan queue item state machine', () => {
  it('walks the happy path from discovery to landed', () => {
    const path: PlanQueueItemState[] = [
      'discovered',
      'queued',
      'preparing',
      'working',
      'awaiting-slot',
      'verifying',
      'landing',
      'landed',
    ];
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransitionItem(path[i - 1], path[i])).toBe(true);
    }
  });

  it('supports the FAIL -> fix -> re-verify cycle', () => {
    expect(canTransitionItem('verifying', 'fixing')).toBe(true);
    expect(canTransitionItem('fixing', 'awaiting-slot')).toBe(true);
    expect(canTransitionItem('awaiting-slot', 'verifying')).toBe(true);
  });

  it('returns a stale PASS to the worker from landing', () => {
    expect(canTransitionItem('landing', 'fixing')).toBe(true);
  });

  it('repeats a discarded verification without consuming a fix round', () => {
    expect(canTransitionItem('verifying', 'awaiting-slot')).toBe(true);
  });

  it('holds a not-ready item until it is answered or skipped', () => {
    expect(canTransitionItem('discovered', 'needs-answer')).toBe(true);
    expect(canTransitionItem('needs-answer', 'queued')).toBe(true);
    expect(canTransitionItem('needs-answer', 'skipped')).toBe(true);
    expect(canTransitionItem('needs-answer', 'preparing')).toBe(false);
  });

  it('lets every non-terminal state park', () => {
    for (const state of ALL_STATES) {
      expect(canTransitionItem(state, 'parked')).toBe(!isTerminalItemState(state));
    }
  });

  it('never leaves landed or skipped', () => {
    for (const to of ALL_STATES) {
      expect(canTransitionItem('landed', to)).toBe(false);
      expect(canTransitionItem('skipped', to)).toBe(false);
    }
  });

  it('only leaves parked through an operator action', () => {
    const allowed = ALL_STATES.filter((to) => canTransitionItem('parked', to));
    expect(allowed.sort()).toEqual(['landing', 'queued']);
  });

  it('cannot skip an item once a worktree exists', () => {
    for (const state of ALL_STATES.filter(itemHoldsWorktree)) {
      expect(canTransitionItem(state, 'skipped')).toBe(false);
    }
  });

  it('cannot land without passing through verification or an operator override', () => {
    const intoLanding = ALL_STATES.filter((from) => canTransitionItem(from, 'landing'));
    expect(intoLanding.sort()).toEqual(['parked', 'verifying']);
  });

  it('reports no worktree for terminal and pre-start states', () => {
    for (const state of ['discovered', 'needs-answer', 'queued', 'landed', 'parked', 'skipped'] as const) {
      expect(itemHoldsWorktree(state)).toBe(false);
    }
  });

  it('throws on an illegal transition', () => {
    expect(() => assertItemTransition('working', 'landed')).toThrow(
      'Illegal plan queue item transition: working -> landed',
    );
    expect(() => assertItemTransition('working', 'awaiting-slot')).not.toThrow();
  });
});
