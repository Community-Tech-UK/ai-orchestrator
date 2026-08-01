import { describe, expect, it } from 'vitest';
import { checkContainedExecutionGate } from './automation-execution-profile-gate';

describe('checkContainedExecutionGate', () => {
  it('always allows a standard profile regardless of provider', () => {
    expect(checkContainedExecutionGate('standard', 'claude')).toEqual({ ok: true });
    expect(checkContainedExecutionGate('standard', undefined)).toEqual({ ok: true });
    expect(checkContainedExecutionGate(undefined, 'gemini')).toEqual({ ok: true });
  });

  it('allows a contained profile resolved to codex', () => {
    expect(checkContainedExecutionGate('contained', 'codex')).toEqual({ ok: true });
  });

  it('refuses a contained profile resolved to a non-codex provider with a plain-language reason', () => {
    const result = checkContainedExecutionGate('contained', 'claude');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Contained runs require Codex — claude cannot enforce isolation.');
  });

  it('refuses a contained profile with an unresolved provider (undefined) — never assumes it would land on codex', () => {
    const result = checkContainedExecutionGate('contained', undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Contained runs require Codex — auto cannot enforce isolation.');
  });

  it('refuses a contained profile still resolved to "auto"', () => {
    const result = checkContainedExecutionGate('contained', 'auto');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('auto cannot enforce isolation');
  });
});
