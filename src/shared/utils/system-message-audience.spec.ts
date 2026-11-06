import { describe, expect, it } from 'vitest';
import {
  ROUTINE_AUDIENCE_METADATA,
  isSystemMessageAudience,
  isSystemMessagePresentationKind,
  isSystemMessageSeverity,
  resolveSystemMessageAudience,
  resolveSystemMessageSeverity,
  withExplicitAudience,
  worstSystemMessageSeverity,
} from './system-message-audience';

function system(metadata?: Record<string, unknown>): { type: string; metadata?: Record<string, unknown> } {
  return { type: 'system', ...(metadata ? { metadata } : {}) };
}

describe('resolveSystemMessageAudience', () => {
  it('defaults to attention, so a notice is never quietened by accident', () => {
    expect(resolveSystemMessageAudience(system())).toBe('attention');
    expect(resolveSystemMessageAudience(system({}))).toBe('attention');
    expect(resolveSystemMessageAudience(system({ audience: 'attention' }))).toBe('attention');
  });

  it('reads only the exact routine flag', () => {
    expect(resolveSystemMessageAudience(system({ audience: 'routine' }))).toBe('routine');
    expect(resolveSystemMessageAudience(system({ audience: 'Routine' }))).toBe('attention');
    expect(resolveSystemMessageAudience(system({ audience: true }))).toBe('attention');
    expect(resolveSystemMessageAudience(system({ audience: undefined }))).toBe('attention');
  });

  it('only applies to system messages', () => {
    for (const type of ['assistant', 'user', 'error', 'tool_use', 'tool_result']) {
      expect(resolveSystemMessageAudience({ type, metadata: { audience: 'routine' } })).toBe('attention');
    }
  });

  it('exposes metadata an emit site can spread in', () => {
    expect(ROUTINE_AUDIENCE_METADATA).toEqual({ audience: 'routine' });
    expect(resolveSystemMessageAudience(system({ ...ROUTINE_AUDIENCE_METADATA, turnId: 't1' }))).toBe('routine');
  });
});

describe('resolveSystemMessageSeverity', () => {
  it('is info unless the emit site says otherwise', () => {
    expect(resolveSystemMessageSeverity(system())).toBe('info');
    expect(resolveSystemMessageSeverity(system({ severity: 'warning' }))).toBe('warning');
    expect(resolveSystemMessageSeverity(system({ severity: 'error' }))).toBe('error');
  });

  it('ignores a severity it does not know', () => {
    expect(resolveSystemMessageSeverity(system({ severity: 'critical' }))).toBe('info');
    expect(resolveSystemMessageSeverity(system({ severity: 3 }))).toBe('info');
  });

  it('treats an error message as an error without needing the flag', () => {
    expect(resolveSystemMessageSeverity({ type: 'error' })).toBe('error');
  });
});

describe('the value guards', () => {
  it('accept exactly the values the readers understand', () => {
    expect(['routine', 'attention', 'Routine', '', undefined, true].map(isSystemMessageAudience))
      .toEqual([true, true, false, false, false, false]);
    expect(['info', 'warning', 'error', 'critical', 3, null].map(isSystemMessageSeverity))
      .toEqual([true, true, true, false, false, false]);
    expect(['request-receipt', 'receipt', '', undefined].map(isSystemMessagePresentationKind))
      .toEqual([true, false, false, false]);
  });
});

describe('withExplicitAudience', () => {
  it('writes attention onto a system message with no audience, leaving the original alone', () => {
    const original = { turnId: 't1' };
    expect(withExplicitAudience('system', undefined)).toEqual({ audience: 'attention' });
    expect(withExplicitAudience('system', original)).toEqual({ turnId: 't1', audience: 'attention' });
    expect(original).toEqual({ turnId: 't1' });
  });

  it('keeps an audience the emit site already named, returning the same object', () => {
    const routine = { ...ROUTINE_AUDIENCE_METADATA };
    const attention = { audience: 'attention' };
    expect(withExplicitAudience('system', routine)).toBe(routine);
    expect(withExplicitAudience('system', attention)).toBe(attention);
  });

  it('replaces a value that is not an audience', () => {
    expect(withExplicitAudience('system', { audience: 'Routine' })).toEqual({ audience: 'attention' });
    expect(withExplicitAudience('system', { audience: true, severity: 'warning' })).toEqual({ audience: 'attention', severity: 'warning' });
  });

  it('leaves every other message type, and a missing type, untouched', () => {
    for (const type of ['assistant', 'user', 'error', 'tool_use', 'tool_result', 'tool_outcome', undefined]) {
      expect(withExplicitAudience(type, undefined)).toBeUndefined();
    }
    const metadata = { exitCode: 1 };
    expect(withExplicitAudience('tool_result', metadata)).toBe(metadata);
  });

  it('gives a message that reads as attention both before and after', () => {
    const before = system();
    const after = { type: 'system', metadata: withExplicitAudience('system', before.metadata) };
    expect(resolveSystemMessageAudience(before)).toBe('attention');
    expect(resolveSystemMessageAudience(after)).toBe('attention');
  });
});

describe('worstSystemMessageSeverity', () => {
  it('returns the most serious severity in the list', () => {
    expect(worstSystemMessageSeverity([system(), system({ severity: 'warning' }), system()])).toBe('warning');
    expect(worstSystemMessageSeverity([system({ severity: 'warning' }), system({ severity: 'error' })])).toBe('error');
    expect(worstSystemMessageSeverity([system({ severity: 'error' }), system({ severity: 'warning' })])).toBe('error');
  });

  it('is info for an empty list or a list of plain notices', () => {
    expect(worstSystemMessageSeverity([])).toBe('info');
    expect(worstSystemMessageSeverity([system(), system()])).toBe('info');
  });
});
