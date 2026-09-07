/**
 * UX5 — rendered against real store state.
 *
 * The two that matter most are the silences: a fully-configured install must
 * see nothing, and an install whose startup report has not landed yet must see
 * nothing rather than a wrong "0 of 3".
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { Router } from '@angular/router';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GettingStartedBarComponent } from './getting-started-bar.component';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { SessionStartedMarkerService } from './session-started-marker.service';
import type { StartupCapabilityReport } from '../../../../shared/types/startup-capability.types';

await resolveComponentResources(() => Promise.resolve(''));

const navigate = vi.fn();

/**
 * Builds the report shape `capability-probe.ts` really emits: a `provider.any`
 * aggregate plus one check per probed provider. The per-provider checks are
 * included deliberately — reading THOSE instead of the aggregate is the bug
 * this component shipped with, and a fixture that omitted them could not catch
 * it coming back.
 */
function report(anyStatus: string, perProvider: string[] = []): StartupCapabilityReport {
  const check = (id: string, status: string) => ({
    id, label: id, category: 'provider', status, critical: false, summary: '',
  });
  return {
    status: 'ready',
    generatedAt: 1,
    checks: [
      check('provider.any', anyStatus),
      ...perProvider.map((status, i) => check(`provider.p${i}`, status)),
    ],
  } as unknown as StartupCapabilityReport;
}

/** What a machine with no CLI on PATH actually produces. */
function zeroCliReport(): StartupCapabilityReport {
  return report('unavailable', ['degraded', 'degraded', 'degraded', 'degraded', 'degraded']);
}

@Component({
  standalone: true,
  imports: [GettingStartedBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-getting-started-bar [report]="report()" />`,
})
class HostComponent {
  readonly report = signal<StartupCapabilityReport | null>(null);
}

describe('GettingStartedBarComponent (UX5)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let cwd: string;
  /**
   * A real signal, not a plain function returning a mutated array. With a plain
   * function the component's `computed` never tracks it, so a test that changed
   * the array and re-rendered could not tell a live count from a persisted
   * marker — which made the first version of the session-close test vacuous.
   */
  let instances: ReturnType<typeof signal<{ id: string }[]>>;

  function mount(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: InstanceStore, useValue: { instances } },
        { provide: SettingsStore, useValue: { settings: () => ({ defaultWorkingDirectory: cwd }) } },
        { provide: Router, useValue: { navigate } },
      ],
    });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  }

  beforeEach(() => {
    navigate.mockClear();
    cwd = '';
    instances = signal<{ id: string }[]>([]);
    window.localStorage.clear();
  });

  function bar(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.getting-started');
  }
  function steps(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.getting-started__step'));
  }

  /** A configured install must not be told it is unconfigured mid-launch. */
  it('shows nothing before the startup report arrives', () => {
    mount();
    expect(bar()).toBeNull();
  });

  it('shows the checklist on a fresh install', () => {
    mount();
    fixture.componentInstance.report.set(zeroCliReport());
    fixture.detectChanges();
    expect(bar()).not.toBeNull();
    expect(steps()).toHaveLength(3);
  });

  it('counts progress as N of M', () => {
    cwd = '/tmp/project';
    mount();
    fixture.componentInstance.report.set(report('ready', ['ready', 'degraded']));
    fixture.detectChanges();
    expect(bar()?.textContent).toContain('2 of 3 done');
  });

  it('puts what is left to do first', () => {
    mount();
    fixture.componentInstance.report.set(report('ready', ['ready', 'degraded']));
    fixture.detectChanges();
    expect(steps()[0]?.getAttribute('data-done')).toBe('false');
    expect(steps()[steps().length - 1]?.getAttribute('data-done')).toBe('true');
  });

  it('says each step’s state in words, not by dimming alone', () => {
    mount();
    fixture.componentInstance.report.set(report('ready', ['ready', 'degraded']));
    fixture.detectChanges();
    expect(bar()?.textContent).toContain('To do');
    expect(bar()?.textContent).toContain('Done');
  });

  /** Completing the steps IS the dismissal — the spec asks for a bar that unmounts. */
  it('unmounts itself once everything is done', () => {
    cwd = '/tmp/project';
    instances = signal([{ id: 'a' }]);
    mount();
    fixture.componentInstance.report.set(report('ready', ['ready', 'degraded']));
    fixture.detectChanges();
    expect(bar()).toBeNull();
  });

  it('offers an action only on the steps still outstanding', () => {
    cwd = '/tmp/project';
    mount();
    fixture.componentInstance.report.set(report('ready', ['ready', 'degraded']));
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('.getting-started__go');
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLElement).getAttribute('data-step-id')).toBe('first-session');
  });

  it('routes each action to the surface that does the job', () => {
    mount();
    fixture.componentInstance.report.set(zeroCliReport());
    fixture.detectChanges();

    const byStep = (id: string) =>
      fixture.nativeElement.querySelector(`.getting-started__go[data-step-id="${id}"]`) as HTMLButtonElement;

    byStep('provider-available').click();
    expect(navigate).toHaveBeenCalledWith(['/settings'], { fragment: 'cli-health' });

    byStep('working-directory').click();
    expect(navigate).toHaveBeenCalledWith(['/settings'], { fragment: 'general' });

    byStep('first-session').click();
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  /**
   * The shipped bug: five `degraded` per-provider checks on a machine with no
   * CLI installed made this step permanently "done". The component must read
   * the aggregate, not those.
   */
  it('does not call a zero-CLI install connected, despite five degraded checks', () => {
    mount();
    fixture.componentInstance.report.set(report('unavailable', ['degraded']));
    fixture.detectChanges();
    expect(bar()?.textContent).toContain('0 of 3 done');
  });
  /**
   * The defect a static `instanceCount` snapshot could never model: closing the
   * only open session used to drop the count to zero and bring the whole bar
   * back, telling a new user to start a session they had just finished.
   */
  it('keeps the session step done after the session is closed', () => {
    cwd = '/tmp/project';
    instances = signal([{ id: 'a' }]);
    mount();
    fixture.componentInstance.report.set(report('ready', ['ready']));
    fixture.detectChanges();
    expect(bar(), 'precondition: all three done, so the bar is gone').toBeNull();

    // The user closes their only session — the ordinary next action.
    instances.set([]);
    fixture.detectChanges();

    expect(bar(), 'the bar must not come back').toBeNull();
    expect(TestBed.inject(SessionStartedMarkerService).hasStarted()).toBe(true);
  });

  it('does not claim a session was started on a device that never had one', () => {
    mount();
    fixture.componentInstance.report.set(zeroCliReport());
    fixture.detectChanges();
    expect(bar()?.textContent).toContain('0 of 3 done');
  });
});
