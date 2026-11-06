import { describe, expect, it } from 'vitest';
import { ADVANCED_SECTION_DEFINITIONS } from './advanced-settings-sections';

describe('advanced settings sections', () => {
  it('shows the helper and output controls once, in their intended cards', () => {
    const membership = new Map<string, string[]>();
    for (const section of ADVANCED_SECTION_DEFINITIONS) {
      for (const key of section.keys) membership.set(key, [...(membership.get(key) ?? []), section.id]);
    }
    expect(membership.get('codexHelperAgentsChats')).toEqual(['codex-economy-heading']);
    expect(membership.get('codexHelperAgentsHarnessWork')).toEqual(['codex-economy-heading']);
    expect(membership.get('codexContextTuning')).toEqual(['codex-economy-heading']);
    expect(membership.get('claudeHelperAgentModel')).toEqual(['claude-helper-agents-heading']);
    expect(membership.get('claudeBashOutputMaxChars')).toEqual(['runtime-controls-heading']);
    expect([...membership.values()].every(cards => cards.length === 1)).toBe(true);
  });
});
