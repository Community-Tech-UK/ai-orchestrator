import { describe, expect, it } from 'vitest';
import { describeInterruptBoundary } from './interrupt-copy';
import { INTERRUPT_BOUNDARY_OUTCOMES, INTERRUPT_BOUNDARY_PHASES } from '../types/interrupt-boundary.types';

describe('interrupt sentences', () => {
  it('covers every phase and outcome without displaying internal codes', () => {
    for (const phase of INTERRUPT_BOUNDARY_PHASES) for (const outcome of INTERRUPT_BOUNDARY_OUTCOMES) {
      const text = describeInterruptBoundary({ phase, outcome });
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/cancelling|escalated|respawning|completed|cancelled|respawn-|unresolved/);
    }
  });
  it.each([
    ['requested', 'unresolved', 'Stopping…'],
    ['cancelling', 'cancelled-for-edit', 'Stopping so you can edit your message…'],
    ['escalated', 'cancelled', "The agent didn't stop, so Harness forced it to stop."],
    ['respawning', 'unresolved', 'Restarting the session…'],
    ['completed', 'cancelled', 'The agent stopped.'],
    ['completed', 'cancelled-for-edit', 'Stopped so you can edit your message.'],
    ['completed', 'respawn-success', 'Stopped. The session restarted and kept its history.'],
    ['completed', 'respawn-fallback', 'Stopped. The session restarted with only your recent messages carried over, so earlier detail may be missing.'],
    ['completed', 'unresolved', 'Stop was requested but not confirmed. The agent may still be running.'],
  ] as const)('%s / %s', (phase, outcome, text) => {
    expect(describeInterruptBoundary({ phase, outcome })).toBe(text);
  });
  it('never promises history was retained when resume was unconfirmed', () => {
    expect(describeInterruptBoundary({ phase: 'completed', outcome: 'respawn-fallback', fallbackMode: 'resume-unconfirmed' }))
      .toBe("Stopped. The session restarted, but Harness couldn't confirm it kept its history.");
  });
});
