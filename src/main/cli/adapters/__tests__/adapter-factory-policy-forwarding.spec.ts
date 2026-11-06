/**
 * Phase 1 wiring tests (plan Steps 1c, 1d and 4): the options that carry a
 * session's policy identity must survive `createCliAdapter` all the way to the
 * adapter that acts on them. Each assertion goes through the real factory and
 * real adapter, so removing the matching forward in `adapter-factory.ts`
 * fails exactly the assertion that depends on it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCliAdapter } from '../adapter-factory';
import type { BaseCliAdapter } from '../base-cli-adapter';
import type { CodexCliConfig } from '../codex-adapter-config';
import { MACHINE_SESSION_DISABLED_PLUGINS } from '../claude-machine-session-policy';

const codexConfigOf = (adapter: unknown): CodexCliConfig =>
  (adapter as { cliConfig: CodexCliConfig }).cliConfig;

describe('adapter factory - Codex trial identity forwarding (plan 1c/1d)', () => {
  const planQueueItem = {
    workingDirectory: '/tmp',
    sessionKind: 'plan-queue' as const,
    trialKey: 'item-1',
    trialKeySource: 'plan-queue-item' as const,
    trialArm: 'cheaper' as const,
    instanceId: 'i1',
  };

  it.each([
    ['sessionKind', 'plan-queue'],
    ['trialKey', 'item-1'],
    ['trialKeySource', 'plan-queue-item'],
    ['trialArm', 'cheaper'],
    ['harnessInstanceId', 'i1'],
  ] as const)('carries %s from the spawn options to the Codex adapter config', (field, expected) => {
    const config = codexConfigOf(createCliAdapter('codex', planQueueItem));
    expect(config[field]).toBe(expected);
  });

  it('leaves every identity field unset for an own chat that supplies none', () => {
    const config = codexConfigOf(createCliAdapter('codex', { workingDirectory: '/tmp' }));
    expect(config.sessionKind).toBeUndefined();
    expect(config.trialKey).toBeUndefined();
    expect(config.trialKeySource).toBeUndefined();
    expect(config.trialArm).toBeUndefined();
    expect(config.harnessInstanceId).toBeUndefined();
  });
});

describe('adapter factory - Claude machine-session forwarding (plan Step 4)', () => {
  const PLUGIN = 'security-guidance@claude-plugins-official';
  // 0 skips the settings-backed ceiling lookup, which is not under test here.
  const base = { workingDirectory: '/tmp', contextCeilingTokens: 0 };

  const envOf = (adapter: unknown): Record<string, string> | undefined =>
    (adapter as BaseCliAdapter).getConfig().env;

  /** The `--settings` overlay the adapter would pass; inline JSON on Unix, a file path on Windows. */
  function settingsOverlayOf(adapter: unknown): { enabledPlugins?: Record<string, boolean> } | undefined {
    const args = (adapter as { buildArgs(message: { role: 'user'; content: string }): string[] })
      .buildArgs({ role: 'user', content: '' });
    const flagIndex = args.indexOf('--settings');
    if (flagIndex < 0) return undefined;
    const value = args[flagIndex + 1];
    return JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(value, 'utf8'));
  }

  it('names the plugin this test expects the policy to disable', () => {
    expect(MACHINE_SESSION_DISABLED_PLUGINS).toEqual([PLUGIN]);
  });

  it('sets SECURITY_GUIDANCE_DISABLE=1 in the spawn env for a machine session', () => {
    const adapter = createCliAdapter('claude', { ...base, machineSession: 'loop' });
    expect(envOf(adapter)?.['SECURITY_GUIDANCE_DISABLE']).toBe('1');
  });

  it('disables the security plugin in the --settings overlay for a machine session', () => {
    const adapter = createCliAdapter('claude', { ...base, machineSession: 'loop' });
    expect(settingsOverlayOf(adapter)?.enabledPlugins).toEqual({ [PLUGIN]: false });
  });

  it('leaves the security plugin alone for a person\'s own chat', () => {
    const adapter = createCliAdapter('claude', { ...base });
    expect(envOf(adapter)?.['SECURITY_GUIDANCE_DISABLE']).toBeUndefined();
    expect(settingsOverlayOf(adapter)?.enabledPlugins?.[PLUGIN]).toBeUndefined();
  });
});
