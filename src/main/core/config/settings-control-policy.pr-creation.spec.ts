/**
 * WS-B1 phase 1 fresh-eyes CRITICAL fix (2026-07-31): `allowPrCreation` must
 * be schema-validated (not a weak `typeof` fallback) and writable ONLY
 * through the renderer Settings-UI IPC path — never the safe MCP tools,
 * never the privileged `aio-mcp settings` CLI.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPrivilegedSettingsCliWritable,
  coerceRendererSettingValue,
  coerceWritableSettingValue,
  getSettingsToolPolicy,
} from './settings-control-policy';

describe('allowPrCreation settings control policy', () => {
  it('is read-only tier with an explicit Record<string,boolean> schema', () => {
    const policy = getSettingsToolPolicy('allowPrCreation');
    expect(policy.tier).toBe('read-only');
    expect(policy.schema).toBeDefined();
  });

  it('rejects the safe MCP tool surface outright', () => {
    expect(() => coerceWritableSettingValue('allowPrCreation', { '/repo': true }))
      .toThrow(/read-only/);
  });

  it('rejects the privileged aio-mcp settings CLI (operator-only anchor)', () => {
    expect(() => assertPrivilegedSettingsCliWritable('allowPrCreation'))
      .toThrow(/operator-only/);
  });

  it('accepts a well-formed renderer write', () => {
    const result = coerceRendererSettingValue('allowPrCreation', { '/repo': true, '/other': false });
    expect(result).toEqual({
      key: 'allowPrCreation',
      value: { '/repo': true, '/other': false },
    });
  });

  it('rejects a malformed renderer write (non-boolean value) — proves schema validation, not typeof', () => {
    // Before the fix, `typeof {'/repo': {nested: true}} === typeof {}` (both
    // 'object') would have passed the old weak fallback. The schema now
    // rejects it because the value at each key must be a boolean.
    expect(() => coerceRendererSettingValue('allowPrCreation', { '/repo': { nested: true } }))
      .toThrow(/Invalid value for allowPrCreation/);
  });

  it('rejects a non-object renderer write', () => {
    expect(() => coerceRendererSettingValue('allowPrCreation', 'not-a-map')).toThrow();
    expect(() => coerceRendererSettingValue('allowPrCreation', ['/repo'])).toThrow();
  });
});

describe('closed-tier renderer coercion hardening (typeof-fallthrough removed for object shapes)', () => {
  it('still allows a well-formed write to a schema-gated Record setting (projectPluginTrust)', () => {
    const result = coerceRendererSettingValue('projectPluginTrust', { '/repo': 'trusted' });
    expect(result).toEqual({ key: 'projectPluginTrust', value: { '/repo': 'trusted' } });
  });

  it('rejects a malformed value on a schema-gated Record setting (projectPluginTrust)', () => {
    expect(() => coerceRendererSettingValue('projectPluginTrust', { '/repo': 'not-a-real-trust-value' }))
      .toThrow();
  });

  it('still allows a well-formed write to a schema-gated Record setting (contextEvidenceModeByProvider)', () => {
    const result = coerceRendererSettingValue('contextEvidenceModeByProvider', { claude: 'shadow' });
    expect(result).toEqual({ key: 'contextEvidenceModeByProvider', value: { claude: 'shadow' } });
  });

  it('rejects a malformed value on a schema-gated Record setting (contextEvidenceModeByProvider)', () => {
    expect(() => coerceRendererSettingValue('contextEvidenceModeByProvider', { claude: 'not-a-mode' }))
      .toThrow();
  });

  it('still allows well-formed writes to primitive-typed closed-tier keys with no schema (regression guard)', () => {
    // These keys are genuinely written by real Settings UI tabs (computer-use,
    // remote-nodes, network) and must keep working — the hardening only
    // removed the fallthrough for object/array-shaped values, not primitives.
    expect(coerceRendererSettingValue('computerUseEnabled', true))
      .toEqual({ key: 'computerUseEnabled', value: true });
    expect(coerceRendererSettingValue('remoteNodesServerHost', '0.0.0.0'))
      .toEqual({ key: 'remoteNodesServerHost', value: '0.0.0.0' });
  });
});
