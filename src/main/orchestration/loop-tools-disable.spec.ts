import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyWrapUpToolsDisable,
  providerEnforcesWrapUpToolsDisable,
} from './loop-tools-disable';

const ADAPTER_DIR = join(__dirname, '..', 'cli', 'adapters');

describe('applyWrapUpToolsDisable', () => {
  it('applies and restores the override on an adapter that supports one', () => {
    const setDisallowedToolsOverride = vi.fn();
    const handle = applyWrapUpToolsDisable({ setDisallowedToolsOverride });

    expect(handle.applied).toBe(true);
    expect(setDisallowedToolsOverride).toHaveBeenCalledWith(expect.any(Array));

    handle.restore();
    expect(setDisallowedToolsOverride).toHaveBeenLastCalledWith(null);
  });

  it('is idempotent on restore, so a reused adapter is not cleared twice', () => {
    const setDisallowedToolsOverride = vi.fn();
    const handle = applyWrapUpToolsDisable({ setDisallowedToolsOverride });

    handle.restore();
    handle.restore();

    expect(setDisallowedToolsOverride).toHaveBeenCalledTimes(2);
  });

  it('reports not-applied for an adapter with no override, without throwing', () => {
    const handle = applyWrapUpToolsDisable({});

    expect(handle.applied).toBe(false);
    expect(() => handle.restore()).not.toThrow();
  });

  it('tolerates a null adapter', () => {
    expect(applyWrapUpToolsDisable(null).applied).toBe(false);
  });
});

/**
 * T45 — the provider list and the adapters that can actually enforce the
 * override must not drift apart. If they do, a capped run on a prompt-only
 * provider silently buys a tool-capable "wrap-up" turn again.
 */
describe('providerEnforcesWrapUpToolsDisable (T45)', () => {
  it('says yes for claude, which implements the override', () => {
    const source = readFileSync(join(ADAPTER_DIR, 'claude-cli-adapter.ts'), 'utf8');
    expect(source).toContain('setDisallowedToolsOverride');
    expect(providerEnforcesWrapUpToolsDisable('claude')).toBe(true);
  });

  // Scans EVERY adapter, not a hand-listed few: a new adapter gaining the
  // override without being added to the provider list would otherwise leave a
  // capped run on that provider silently buying a tool-capable "wrap-up" turn.
  it('is the only adapter that implements the override', () => {
    const implementers = readdirSync(ADAPTER_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .filter((name) => readFileSync(join(ADAPTER_DIR, name), 'utf8')
        .includes('setDisallowedToolsOverride('));

    expect(
      implementers.sort(),
      'an adapter gained setDisallowedToolsOverride — add its provider to '
      + 'WRAP_UP_TOOLS_DISABLE_PROVIDERS in loop-tools-disable.ts',
    ).toEqual(['claude-cli-adapter.ts']);
  });

  it('says no for the providers whose adapters do not implement it', () => {
    for (const provider of ['codex', 'gemini', 'copilot', 'cursor', 'grok', 'antigravity', 'ollama']) {
      expect(providerEnforcesWrapUpToolsDisable(provider), provider).toBe(false);
    }
  });

  it('normalises casing and whitespace', () => {
    expect(providerEnforcesWrapUpToolsDisable('  Claude ')).toBe(true);
  });

  it('says no for an unknown or absent provider', () => {
    expect(providerEnforcesWrapUpToolsDisable(undefined)).toBe(false);
    expect(providerEnforcesWrapUpToolsDisable('no-such-provider')).toBe(false);
  });
});
