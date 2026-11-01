import { afterEach, describe, expect, it } from 'vitest';
import {
  getDefaultModelForCli,
  isAntigravityModelId,
  resolveModelForTier,
} from '../provider-model-utils';
import {
  clearKnownModelCatalogSnapshotForTesting,
  replaceKnownModelCatalogSnapshot,
} from '../provider-model-catalog-snapshot';
import { DEFAULT_LOOP_MODEL_BY_PROVIDER } from '../settings-defaults';


/**
 * T41 — Antigravity is a CLI-only provider with no `ProviderType` member, so it
 * had no house default: a router-off spawn passed no `--model` and agy silently
 * picked its own.
 */
describe('getDefaultModelForCli for antigravity (T41)', () => {
  afterEach(() => {
    clearKnownModelCatalogSnapshotForTesting();
  });

  it('returns a default rather than undefined', () => {
    expect(getDefaultModelForCli('antigravity')).toBeTruthy();
  });

  it('picks the balanced Gemini Flash at Medium effort, not agy\'s flagship default', () => {
    expect(getDefaultModelForCli('antigravity')).toBe('Gemini 3.8 Flash (Medium)');
  });

  it('follows the newest Flash on the live agy list without a code edit', () => {
    replaceKnownModelCatalogSnapshot([
      { provider: 'antigravity', id: 'Gemini 5 Boron (Medium)', pinned: true },
      { provider: 'antigravity', id: 'Gemini 3.9 Flash (Medium)', pinned: true },
      { provider: 'antigravity', id: 'Gemini 3.10 Flash (Medium)', pinned: true },
      { provider: 'antigravity', id: 'Gemini 3.10 Flash (High)' },
    ]);

    // Versions compare numerically: 3.10 is newer than 3.9.
    expect(getDefaultModelForCli('antigravity')).toBe('Gemini 3.10 Flash (Medium)');
  });

  it('falls back to agy\'s first pinned model when it lists no Flash model', () => {
    replaceKnownModelCatalogSnapshot([
      { provider: 'antigravity', id: 'Gemini 5 Boron (Medium)', pinned: true },
    ]);

    expect(getDefaultModelForCli('antigravity')).toBe('Gemini 5 Boron (Medium)');
  });

  it('returns an EXACT agy display label, not a gemini-* wire id', () => {
    const model = getDefaultModelForCli('antigravity')!;
    // agy exits 1 on an unknown --model, so the value must be a label the
    // catalog itself lists.
    expect(isAntigravityModelId(model)).toBe(true);
    expect(model).not.toMatch(/^gemini-/);
  });

  it('leaves the other CLI mappings alone', () => {
    expect(getDefaultModelForCli('claude')).toBeTruthy();
    expect(getDefaultModelForCli('no-such-cli')).toBeUndefined();
  });
});

describe('DEFAULT_LOOP_MODEL_BY_PROVIDER pins (T41)', () => {
  it('pins claude, gemini and grok alongside codex', () => {
    expect(DEFAULT_LOOP_MODEL_BY_PROVIDER['claude']).toBe(resolveModelForTier('balanced', 'claude'));
    expect(DEFAULT_LOOP_MODEL_BY_PROVIDER['gemini']).toBe(resolveModelForTier('balanced', 'gemini'));
    expect(DEFAULT_LOOP_MODEL_BY_PROVIDER['codex']).toBe(resolveModelForTier('balanced', 'codex'));
  });

  // Grok has no balanced row; the honest pin is the id that actually runs.
  it('pins grok to the id the CLI really spawns', () => {
    expect(resolveModelForTier('balanced', 'grok')).toBeUndefined();
    expect(DEFAULT_LOOP_MODEL_BY_PROVIDER['grok']).toBe('grok-4.7');
  });

  // Copilot is an EBRD-only seat; silently retargeting it is out of scope.
  it('does not pin copilot', () => {
    expect(DEFAULT_LOOP_MODEL_BY_PROVIDER['copilot']).toBeUndefined();
  });
});
