/**
 * Render-level guarantee for the Help & tips pane: every registry entry
 * (all Control Center surfaces and all Settings tabs) renders each of its
 * sections through the real template. Catches template/kind mismatches that
 * data-only checks cannot.
 *
 * The Angular compiler plugin is absent from the vitest config so
 * signal-input wiring via TestBed.setInput() is unreliable; we override the
 * signal-input getters directly on the instance (same workaround as
 * checkpoint-timeline.component.spec.ts).
 */

import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { HelpPaneComponent } from './help-pane.component';
import { CONTROL_SURFACE_HELP } from './control-surface-help';
import { SETTINGS_TAB_HELP } from '../../features/settings/help/settings-help';
import type { HelpEntry, HelpLiveStatus } from './help-content.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));

const resources: Record<string, string> = {
  'help-pane.component.html': readFileSync(resolve(specDirectory, './help-pane.component.html'), 'utf8'),
  'help-pane.component.scss': readFileSync(resolve(specDirectory, './help-pane.component.scss'), 'utf8'),
  'inline-help.component.scss': readFileSync(resolve(specDirectory, './inline-help.component.scss'), 'utf8'),
};

await resolveComponentResources((url) => {
  const match = Object.entries(resources).find(([name]) => url.endsWith(name));
  if (match) {
    return Promise.resolve(match[1]);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

interface PaneInputs {
  entry: HelpEntry;
  collapsed?: boolean;
  status?: HelpLiveStatus | null;
}

describe('HelpPaneComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HelpPaneComponent],
    }).compileComponents();
  });

  function createPane(inputs: PaneInputs): ComponentFixture<HelpPaneComponent> {
    const fixture = TestBed.createComponent(HelpPaneComponent);
    const component = fixture.componentInstance as unknown as {
      entry: () => HelpEntry;
      collapsed: () => boolean;
      status: () => HelpLiveStatus | null;
    };
    component.entry = () => inputs.entry;
    component.collapsed = () => inputs.collapsed ?? false;
    component.status = () => inputs.status ?? null;
    fixture.detectChanges();
    return fixture;
  }

  /**
   * Expected rendered text per section. Callout headings pass through the
   * inline-help signal input, which the vitest JIT env does not bind (known
   * limitation; AOT builds render them fine) - so for callouts we assert the
   * projected body text instead.
   */
  function expectedTexts(entry: HelpEntry): string[] {
    return entry.sections.map((section) => {
      if (section.kind === 'callout') {
        return section.body;
      }
      if (section.kind === 'recommend') {
        return section.heading ?? 'Recommended settings';
      }
      return section.heading;
    });
  }

  it('renders every section of every control-surface entry', () => {
    for (const [id, entry] of Object.entries(CONTROL_SURFACE_HELP)) {
      const fixture = createPane({ entry });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      for (const expected of expectedTexts(entry)) {
        expect(text, `surface ${id}: section "${expected.slice(0, 40)}" renders`).toContain(expected);
      }
      fixture.destroy();
    }
  });

  it('renders every section of every settings-tab entry', () => {
    for (const [id, entry] of Object.entries(SETTINGS_TAB_HELP)) {
      const fixture = createPane({ entry });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      for (const expected of expectedTexts(entry)) {
        expect(text, `tab ${id}: section "${expected.slice(0, 40)}" renders`).toContain(expected);
      }
      fixture.destroy();
    }
  });

  it('injects a live status callout after the lead section', () => {
    const fixture = createPane({
      entry: CONTROL_SURFACE_HELP['models'],
      status: { variant: 'warning', text: '2 of 4 provider CLIs ready.' },
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('2 of 4 provider CLIs ready.');
  });

  it('collapses to the rail and emits toggle', () => {
    const fixture = createPane({ entry: CONTROL_SURFACE_HELP['logs'], collapsed: true });
    let toggles = 0;
    fixture.componentInstance.toggled.subscribe(() => toggles++);

    const rail = (fixture.nativeElement as HTMLElement).querySelector('.help-pane-rail');
    expect(rail, 'collapsed rail renders').not.toBeNull();
    (rail as HTMLButtonElement).click();
    expect(toggles).toBe(1);
  });
});
