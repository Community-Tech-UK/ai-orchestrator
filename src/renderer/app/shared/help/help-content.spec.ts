import { describe, expect, it } from 'vitest';

import { CONTROL_SURFACES } from '../control-surface/control-surface.registry';
import { CONTROL_SURFACE_HELP } from './control-surface-help';
import { SETTINGS_TAB_HELP } from '../../features/settings/help/settings-help';
import type { HelpEntry } from './help-content.types';
import { HELP_TOPICS } from './help-topics';
import { UI_TERMS } from '../../../../shared/copy/ui-vocabulary';

/**
 * Content-quality guardrails for the Help & tips registries. The Record types
 * already force an entry per page at compile time; these checks keep each
 * entry genuinely useful rather than an empty stub.
 */

function expectUsefulEntry(id: string, entry: HelpEntry): void {
  expect(entry.sections.length, `${id}: has sections`).toBeGreaterThan(0);

  const lead = entry.sections[0];
  expect(lead.kind, `${id}: leads with a callout`).toBe('callout');
  if (lead.kind === 'callout') {
    expect(lead.variant, `${id}: lead callout is informational`).toBe('info');
    expect(lead.body.length, `${id}: lead body is substantive`).toBeGreaterThan(40);
  }

  const hasGuidance = entry.sections.some(
    (section) =>
      (section.kind === 'callout' && section.variant !== 'info') ||
      section.kind === 'recommend' ||
      section.kind === 'steps',
  );
  expect(hasGuidance, `${id}: includes a tip, warning, steps, or recommendation`).toBe(true);
}

describe('CONTROL_SURFACE_HELP', () => {
  it('covers every registered control surface', () => {
    for (const surface of CONTROL_SURFACES) {
      expect(CONTROL_SURFACE_HELP[surface.id], `missing help for ${surface.id}`).toBeDefined();
    }
  });

  it('every entry is genuinely useful', () => {
    for (const [id, entry] of Object.entries(CONTROL_SURFACE_HELP)) {
      expectUsefulEntry(id, entry);
    }
  });
});

describe('SETTINGS_TAB_HELP', () => {
  it('every entry is genuinely useful', () => {
    for (const [id, entry] of Object.entries(SETTINGS_TAB_HELP)) {
      expectUsefulEntry(id, entry);
    }
  });
});

describe('HELP_TOPICS', () => {
  it('provides useful in-app help and keeps loop and session copy in the canonical vocabulary', () => {
    for (const [id, topic] of Object.entries(HELP_TOPICS)) {
      expectUsefulEntry(id, topic.entry);
      if (id === 'glossary') continue; // Alias lines deliberately preserve search names.
      const text = topic.entry.sections.map(section => {
        if (section.kind === 'callout') return `${section.heading} ${section.body}`;
        if (section.kind === 'list' || section.kind === 'steps') return `${section.heading} ${section.items.join(' ')}`;
        return '';
      }).join(' ');
      for (const term of UI_TERMS) {
        for (const pattern of term.never) expect(text, `${id}: ${term.id}`).not.toMatch(pattern);
      }
    }
  });
});
