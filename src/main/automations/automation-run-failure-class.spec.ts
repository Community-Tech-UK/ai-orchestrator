import { describe, expect, it } from 'vitest';
import {
  classifyAutomationRunFailure,
  isBusyConversationSendError,
} from './automation-run-failure-class';

describe('classifyAutomationRunFailure (A15 / 8a)', () => {
  it('maps each 30-day failure string to its class', () => {
    expect(classifyAutomationRunFailure('Thread wakeup failed: target_missing')).toBe('never');
    expect(
      classifyAutomationRunFailure('Thread wakeup failed: target_missing (history gone)'),
    ).toBe('never');
    expect(
      classifyAutomationRunFailure('Codex turn stalled: no notifications received for 900000ms'),
    ).toBe('never');
    expect(
      classifyAutomationRunFailure('This content was flagged for possible cybersecurity risk'),
    ).toBe('never');
    expect(classifyAutomationRunFailure('workspace routing discovery failed')).toBe('never');
  });

  it('maps busy conversations and resource limits to wait', () => {
    expect(
      classifyAutomationRunFailure('Instance creation is paused by the resource governor (instance-limit)'),
    ).toBe('wait');
    expect(
      classifyAutomationRunFailure(
        'Thread wakeup send failed: Codex app-server runtime already has an active turn',
      ),
    ).toBe('wait');
  });

  it('classifies unknown text as normal', () => {
    expect(classifyAutomationRunFailure('boom')).toBe('normal');
    expect(classifyAutomationRunFailure('Thread wakeup send failed: EPIPE')).toBe('normal');
    expect(classifyAutomationRunFailure('')).toBe('normal');
    expect(classifyAutomationRunFailure(undefined)).toBe('normal');
    expect(classifyAutomationRunFailure(null)).toBe('normal');
  });

  it('recognises the busy send race', () => {
    expect(
      isBusyConversationSendError('Codex app-server runtime already has an active turn'),
    ).toBe(true);
    expect(isBusyConversationSendError('EPIPE')).toBe(false);
  });
});
