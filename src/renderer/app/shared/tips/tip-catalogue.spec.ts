import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '../../../../shared/types/keybinding.types';
import { WORKING_TIPS } from './tip-catalogue';

describe('working tip catalogue integration guard', () => {
  it('contains seven unique short, single-line tips using the visible product vocabulary', () => {
    expect(WORKING_TIPS).toHaveLength(7);
    expect(new Set(WORKING_TIPS.map((tip) => tip.id)).size).toBe(7);
    for (const tip of WORKING_TIPS) {
      expect(tip.text.length).toBeLessThanOrEqual(110);
      expect(tip.text).not.toMatch(/\n|AIO|Orchestrator|instance/);
    }
  });
  it('has live keybindings and real usage recorder sites for every feature', () => {
    // The global actions are registered for the whole app lifetime now; a few stay on the dashboard.
    const dashboard = readFileSync(resolve('src/renderer/app/features/dashboard/dashboard.component.ts'), 'utf8')
      + readFileSync(resolve('src/renderer/app/features/commands/palette-overlays.service.ts'), 'utf8');
    const recorderSource = dashboard + readFileSync(resolve('src/renderer/app/features/instance-detail/instance-detail.component.ts'), 'utf8')
      + readFileSync(resolve('src/renderer/app/features/compare/ask-council.store.ts'), 'utf8');
    for (const tip of WORKING_TIPS) {
      if (tip.shortcutActionId) {
        expect(DEFAULT_KEYBINDINGS.some((binding) => binding.action === tip.shortcutActionId)).toBe(true);
        expect(dashboard).toContain(`id: '${tip.shortcutActionId}'`);
      } else {
        expect(recorderSource).toContain(`featureUsage.record('${tip.featureId}')`);
      }
    }
  });
  it('keeps unavailable compaction previews ineligible despite a full context window', () => {
    const tip = WORKING_TIPS.find((entry) => entry.id === 'compact-preview')!;
    expect(tip.relevantWhen?.({ sessionCount: 4, hasReply: true, contextPercentage: 90, compactPreviewAvailable: false })).toBe(false);
    expect(tip.relevantWhen?.({ sessionCount: 4, hasReply: true, contextPercentage: 60, compactPreviewAvailable: true })).toBe(true);
  });
});
