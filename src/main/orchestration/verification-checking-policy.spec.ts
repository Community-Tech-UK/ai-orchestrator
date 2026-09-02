import { describe, expect, it, vi } from 'vitest';

/**
 * WS9. The verification panel was the one checking surface with no model policy
 * at all: it picked N different CLIs and let each use its own default. Different
 * CLI does not mean different vendor — Copilot and Cursor each front several —
 * so a panel could agree with itself and look independent doing it.
 */
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      // Both of these resolve to the Anthropic family: the collision the policy
      // has to break up.
      crossModelReviewModelByProvider: {
        cursor: 'claude-opus-5-thinking-high',
        copilot: 'claude-opus-5',
        claude: 'opus',
        codex: 'gpt-5.6-terra',
      },
      copilotAccountProfiles: [],
      copilotAccountRoutingRules: [],
    }),
  }),
}));

import { createVerificationModelAssigner } from './verification-checking-policy';
import { modelFamily } from '../../shared/models/model-family';

/** Convenience: run a whole panel through one assigner, in order. */
function assignPanel(clis: readonly string[]): Array<string | undefined> {
  const assign = createVerificationModelAssigner();
  return clis.map((cli) => assign(cli));
}

describe('createVerificationModelAssigner', () => {
  it('leaves a panel alone when every member is already a different vendor', () => {
    // claude -> anthropic, codex -> openai. No collision, no interference.
    expect(assignPanel(['claude', 'codex'])).toEqual([undefined, undefined]);
  });

  it('re-models the SECOND member of a colliding pair, not the first', () => {
    const [claude, cursor] = assignPanel(['claude', 'cursor']);

    expect(claude).toBeUndefined();
    expect(cursor).toBeDefined();
    expect(modelFamily(cursor)).not.toBe('anthropic');
  });

  it('gives three colliding members three distinct vendors', () => {
    const assigned = assignPanel(['claude', 'cursor', 'copilot']);

    const families = new Set<string>(['anthropic']); // claude keeps its own
    for (const model of assigned.slice(1)) {
      expect(model).toBeDefined();
      families.add(modelFamily(model));
    }
    expect(families.size).toBe(3);
  });

  it('separates DUPLICATE CLI names instead of giving both the same model', () => {
    // A name-keyed map collapsed these into one entry, so both agents ran the
    // identical model — corroboration that only looked independent. The IPC
    // schema for `cliAgents` permits duplicates.
    const [first, second] = assignPanel(['copilot', 'copilot']);

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(modelFamily(second)).not.toBe(modelFamily('claude-opus-5'));
  });

  it('leaves an unidentifiable model alone rather than pinning it', () => {
    expect(assignPanel(['unknown-cli'])).toEqual([undefined]);
  });

  it('handles a single-member panel', () => {
    expect(assignPanel(['claude'])).toEqual([undefined]);
  });
});
