import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { AutomationAuthorityPanelComponent } from './automation-authority-panel.component';
import { AUTOMATION_AUTHORITY_TEMPLATES, type AutomationAuthorityInput } from './automation-authority';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const templateSource = readFileSync(resolve(specDirectory, './automation-authority-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './automation-authority-panel.component.css'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('automation-authority-panel.component.html')) return Promise.resolve(templateSource);
  if (url.endsWith('automation-authority-panel.component.css')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.css') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const SAMPLE_INPUT: AutomationAuthorityInput = {
  workingDirectory: '/repo/project',
  yoloMode: false,
  concurrencyPolicy: 'skip',
  destinationKind: 'newInstance',
  loop: { enabled: false, verifyCommand: '', isolateWorkspace: true },
};

describe('AutomationAuthorityPanelComponent', () => {
  let fixture: ComponentFixture<AutomationAuthorityPanelComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AutomationAuthorityPanelComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AutomationAuthorityPanelComponent);
    fixture.componentRef.setInput('authorityInput', SAMPLE_INPUT);
    fixture.detectChanges();
  });

  it('renders all six authority cards', () => {
    const titles = (Array.from(fixture.nativeElement.querySelectorAll('.authority-card__title')) as HTMLElement[])
      .map((el) => el.textContent?.trim());
    expect(titles).toEqual([
      'May access',
      'May change',
      'Must ask before',
      'Stops when',
      'Verification',
      'Report destination',
    ]);
  });

  it('marks each statement with a distinct badge label, not colour alone', () => {
    const badges = Array.from(fixture.nativeElement.querySelectorAll('.authority-badge')) as HTMLElement[];
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(['Enforced', 'Prompt only']).toContain(badge.textContent?.trim());
    }
    // At least one instruction-only statement should exist for a non-loop automation
    // (its "verification" card has no technical gate) — confirm the distinct label renders.
    expect(badges.some((badge) => badge.textContent?.trim() === 'Prompt only')).toBe(true);
  });

  it('hides the template row when no templates are provided', () => {
    expect(fixture.nativeElement.querySelector('.authority-templates')).toBeNull();
  });

  it('shows and applies the three one-click presets when templates are provided', () => {
    fixture.componentRef.setInput('templates', AUTOMATION_AUTHORITY_TEMPLATES);
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.authority-template-btn')) as HTMLButtonElement[];
    expect(buttons.map((btn) => btn.textContent?.trim())).toEqual([
      'Read-only monitor',
      "Prepare, don't publish",
      'Implement in one repo',
    ]);

    let emitted: unknown;
    fixture.componentInstance.templateApplied.subscribe((id: unknown) => {
      emitted = id;
    });
    buttons[1].click();
    expect(emitted).toBe('prepare-dont-publish');
  });
});
