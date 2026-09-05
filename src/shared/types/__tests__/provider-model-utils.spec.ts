import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_HOUSE_DEFAULT_MODEL_ID,
  getDefaultModelForCli,
  isAntigravityModelId,
  resolveModelForTier,
} from '../provider-model-utils';
import { DEFAULT_LOOP_MODEL_BY_PROVIDER } from '../settings-defaults';


/**
 * T41 — Antigravity is a CLI-only provider with no `ProviderType` member, so it
 * had no house default: a router-off spawn passed no `--model` and agy silently
 * picked its own.
 */
describe('getDefaultModelForCli for antigravity (T41)', () => {
  it('returns a default rather than undefined', () => {
    expect(getDefaultModelForCli('antigravity')).toBeTruthy();
  });

  it('names the house default explicitly rather than taking whichever balanced row is first', () => {
    // The antigravity catalog has three pinned `balanced` rows; a `.find()` on
    // tier alone would make the default an accident of array order.
    expect(getDefaultModelForCli('antigravity')).toBe(ANTIGRAVITY_HOUSE_DEFAULT_MODEL_ID);
  });

  it('returns an EXACT agy display label, not a gemini-* wire id', () => {
    const model = getDefaultModelForCli('antigravity')!;
    // agy ignores an unknown --model without warning (G35), so the value must
    // be a label the catalog itself lists.
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
    expect(DEFAULT_LOOP_MODEL_BY_PROVIDER['grok']).toBe('grok-4.6');
  });

  // Copilot is an EBRD-only seat; silently retargeting it is out of scope.
  it('does not pin copilot', () => {
    expect(DEFAULT_LOOP_MODEL_BY_PROVIDER['copilot']).toBeUndefined();
  });
});
