/**
 * S3.4 — rendered against the real registry, so a notice that stops firing
 * (or starts firing on the wrong tab) fails here rather than quietly vanishing.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { SettingsHealthNoticesComponent } from './settings-health-notices.component';
import { SettingsStore } from '../../core/state/settings.store';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings-defaults';

await resolveComponentResources(() => Promise.resolve(''));

@Component({
  standalone: true,
  imports: [SettingsHealthNoticesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-settings-health-notices [tab]="tab()" />`,
})
class HostComponent {
  readonly tab = signal('review');
}

describe('SettingsHealthNoticesComponent (S3.4)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let settings: ReturnType<typeof signal<Record<string, unknown>>>;

  beforeEach(async () => {
    settings = signal<Record<string, unknown>>({ ...(DEFAULT_SETTINGS as unknown as Record<string, unknown>) });
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: SettingsStore, useValue: { settings } }],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  function notices(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.settings-health-notice'));
  }

  it('shows the review tab’s notice on default settings', () => {
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.getAttribute('data-notice-id')).toBe('cross-model-review-local-no-selector');
  });

  it('renders nothing on a tab with no active notices', () => {
    fixture.componentInstance.tab.set('keyboard');
    fixture.detectChanges();
    expect(notices()).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.settings-health-notices')).toBeNull();
  });

  it('reacts to a settings change without a remount', () => {
    settings.update((s) => ({ ...s, crossModelReviewLocalSelectorId: 'a-model' }));
    fixture.detectChanges();
    expect(notices()).toHaveLength(0);
  });

  it('names the severity in words, not only in colour', () => {
    expect(notices()[0]?.querySelector('.settings-health-notice__severity')?.textContent?.trim())
      .toBe('Check this');
  });

  it('says "Note" for an informational notice', () => {
    fixture.componentInstance.tab.set('memory');
    fixture.detectChanges();
    expect(notices()[0]?.querySelector('.settings-health-notice__severity')?.textContent?.trim())
      .toBe('Note');
  });

  it('renders the message text a user actually reads', () => {
    expect(notices()[0]?.textContent).toContain('no local model is selected');
  });

  it('announces itself rather than being drawn silently', () => {
    expect(fixture.nativeElement.querySelector('.settings-health-notices')?.getAttribute('role'))
      .toBe('status');
  });

  it('switches its notices when the tab changes', () => {
    fixture.componentInstance.tab.set('memory');
    fixture.detectChanges();
    expect(notices()[0]?.getAttribute('data-notice-id')).toBe('loop-uses-its-own-context-threshold');
  });
});
