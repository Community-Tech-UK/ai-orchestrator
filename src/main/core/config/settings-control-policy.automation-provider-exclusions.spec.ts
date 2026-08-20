/**
 * Fresh-eyes completion-gate finding (2026-08-19), same pattern as the WS-B1
 * `allowPrCreation` fix (settings-control-policy.pr-creation.spec.ts):
 * `providersExcludedFromAutomation` is the licence guardrail that keeps an
 * operator-excluded provider (e.g. a work-only Copilot seat) out of every
 * automatic selection path. It was marked `readOnly()` — which blocks the
 * safe MCP `set_setting` tool — but was never added to
 * `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`, so the privileged `aio-mcp settings
 * set` CLI (routinely used by agent sessions per AGENTS.md) could still
 * clear or edit it, defeating the entire guardrail the plan exists to
 * provide.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
} from './settings-control-policy';

describe('providersExcludedFromAutomation settings control policy', () => {
  it('is read-only tier with an explicit array schema', () => {
    const policy = getSettingsToolPolicy('providersExcludedFromAutomation');
    expect(policy.tier).toBe('read-only');
    expect(policy.schema).toBeDefined();
  });

  it('rejects the safe MCP tool surface outright', () => {
    expect(() => coerceWritableSettingValue('providersExcludedFromAutomation', ['copilot']))
      .toThrow(/read-only/);
  });

  it('rejects the privileged aio-mcp settings CLI (operator-only anchor)', () => {
    expect(() => assertPrivilegedSettingsCliWritable('providersExcludedFromAutomation'))
      .toThrow(/operator-only/);
  });

  it('accepts a well-formed renderer write (Settings UI is the trusted human surface)', () => {
    const result = coerceRendererSettingValue('providersExcludedFromAutomation', ['copilot']);
    expect(result).toEqual({
      key: 'providersExcludedFromAutomation',
      value: ['copilot'],
    });
  });

  it('rejects a malformed renderer write (unknown provider id)', () => {
    expect(() => coerceRendererSettingValue('providersExcludedFromAutomation', ['not-a-real-provider']))
      .toThrow();
  });
});
