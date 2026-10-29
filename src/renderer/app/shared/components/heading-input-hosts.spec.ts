import { Component, reflectComponentType, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyStateComponent } from './empty-state/empty-state.component';
import { PageHeaderComponent } from './page-header/page-header.component';
import { PromptModalComponent } from './prompt-modal/prompt-modal.component';
import { TaskPreflightCardComponent } from './task-preflight-card.component';
import { SettingsCardComponent } from '../../features/settings/ui/settings-card.component';
import { DangerZoneComponent } from '../../features/settings/ui/danger-zone.component';

await resolveComponentResources(url => {
  if (url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({ standalone: true,
  imports: [EmptyStateComponent, PageHeaderComponent, PromptModalComponent, TaskPreflightCardComponent, SettingsCardComponent, DangerZoneComponent],
  template: `
    <app-empty-state heading="Empty heading" />
    <app-page-header heading="Page heading" subtitle="Page subtitle" />
    <app-prompt-modal heading="Dialog heading" [isOpen]="true" />
    <app-task-preflight-card heading="Preflight heading" subtitle="Preflight subtitle" />
    <app-settings-card heading="Settings heading" />
    <app-danger-zone heading="Danger heading" />
  `,
})
class HeadingHost {}

afterEach(() => TestBed.resetTestingModule());

describe('shared heading inputs', () => {
  const cases = [
    [EmptyStateComponent, 'app-empty-state', 'Empty heading'],
    [PageHeaderComponent, 'app-page-header', 'Page heading'],
    [PromptModalComponent, 'app-prompt-modal', 'Dialog heading'],
    [TaskPreflightCardComponent, 'app-task-preflight-card', 'Preflight heading'],
    [SettingsCardComponent, 'app-settings-card', 'Settings heading'],
    [DangerZoneComponent, 'app-danger-zone', 'Danger heading'],
  ] as const;

  for (const [component, selector, heading] of cases) {
    it(`renders ${selector}'s heading without a native title on its host`, () => {
      const inputs = reflectComponentType<unknown>(component)?.inputs.map(input => input.propName);
      expect(inputs).toContain('heading');
      expect(inputs).not.toContain('title');
      TestBed.configureTestingModule({ imports: [HeadingHost], providers: [{ provide: Router, useValue: { navigate: vi.fn() } }] });
      const fixture = TestBed.createComponent(HeadingHost);
      fixture.detectChanges();
      const host: HTMLElement = fixture.nativeElement.querySelector(selector);
      expect(host.textContent).toContain(heading);
      expect(host.hasAttribute('title')).toBe(false);
      expect(fixture.nativeElement.textContent).toContain('Page subtitle');
      expect(fixture.nativeElement.textContent).toContain('Preflight subtitle');
    });
  }
});
