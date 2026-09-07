/**
 * B5 — rendered against the REAL reducer output for each seeded state, so the
 * component and the reducer cannot drift into disagreeing about what "blocked"
 * looks like.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { LoopCausalTimelineComponent } from './loop-causal-timeline.component';
import { buildLoopCausalTimeline, type LoopTimeline } from './loop-causal-timeline';

await resolveComponentResources(() => Promise.resolve(''));

@Component({
  standalone: true,
  imports: [LoopCausalTimelineComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-loop-causal-timeline
      [timeline]="timeline()"
      (recoveryChosen)="chosen.push($event)"
    />
  `,
})
class HostComponent {
  readonly timeline = signal<LoopTimeline | null>(null);
  readonly chosen: string[] = [];
}

describe('LoopCausalTimelineComponent (B5)', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  function seed(status: string, extra: Record<string, unknown> = {}): void {
    fixture.componentInstance.timeline.set(
      buildLoopCausalTimeline({ status, iteration: 3, maxIterations: 50, ...extra }),
    );
    fixture.detectChanges();
  }

  function steps(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.loop-timeline__step'));
  }

  it('renders nothing without a timeline', () => {
    expect(fixture.nativeElement.querySelector('.loop-timeline')).toBeNull();
  });

  it('renders the four steps for a running loop', () => {
    seed('running');
    expect(steps().map((s) => s.getAttribute('data-step-id')))
      .toEqual(['work', 'verify', 'review', 'decision']);
  });

  it('names each step’s state in words, not by colour alone', () => {
    seed('cap-reached');
    const blocked = steps().find((s) => s.getAttribute('data-state') === 'blocked')!;
    expect(blocked.textContent).toContain('blocked');
  });

  it('shows why the blocking step is blocked', () => {
    seed('cap-reached');
    expect(fixture.nativeElement.textContent).toContain('iteration cap');
  });

  it('always says what happens next without the operator', () => {
    seed('running');
    expect(fixture.nativeElement.querySelector('.loop-timeline__next')?.textContent)
      .toContain('continues to iteration 4 of 50');
  });

  it('offers a recovery action for a capped run and emits its id', () => {
    seed('cap-reached');
    const button = fixture.nativeElement.querySelector('.loop-timeline__recovery-btn') as HTMLButtonElement;
    expect(button.getAttribute('data-recovery-id')).toBe('raise-cap');
    button.click();
    expect(fixture.componentInstance.chosen).toEqual(['raise-cap']);
  });

  it('offers no recovery button while the run is progressing', () => {
    seed('running');
    expect(fixture.nativeElement.querySelector('.loop-timeline__recovery-btn')).toBeNull();
  });

  /** The provider-limit park resumes itself; the UI must not imply otherwise. */
  it('tells a parked provider-limit run that it resumes on its own', () => {
    seed('provider-limit', { endedAt: null });
    expect(fixture.nativeElement.querySelector('.loop-timeline__next')?.textContent)
      .toContain('resumes on its own');
  });

  it('labels the spend figure as estimated or provider-reported', () => {
    seed('running', { spentCents: 250 });
    expect(fixture.nativeElement.querySelector('.loop-timeline__spend-source')?.textContent?.trim())
      .toBe('estimated');
    seed('running', { spentCents: 250, spendIsProviderReported: true });
    expect(fixture.nativeElement.querySelector('.loop-timeline__spend-source')?.textContent?.trim())
      .toBe('provider-reported');
  });

  it('shows the cap alongside the spend when there is one', () => {
    seed('running', { spentCents: 250, maxCostCents: 2000 });
    const spend = fixture.nativeElement.querySelector('.loop-timeline__spend') as HTMLElement;
    expect(spend.textContent).toContain('$2.50');
    expect(spend.textContent).toContain('of $20.00');
  });

  it('omits the cap when the run is uncapped', () => {
    seed('running', { spentCents: 250, maxCostCents: null });
    expect(fixture.nativeElement.querySelector('.loop-timeline__spend-cap')).toBeNull();
  });

  it('announces the state once in a polite live region', () => {
    seed('cap-reached');
    const live = fixture.nativeElement.querySelector('.loop-timeline__announcement') as HTMLElement;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('Blocked at Terminal decision');
  });

  it('dims a step this run does not use rather than hiding it', () => {
    seed('running', { hasVerifyCommand: false });
    const verify = steps().find((s) => s.getAttribute('data-step-id') === 'verify')!;
    expect(verify.getAttribute('data-state')).toBe('skipped');
    expect(verify.textContent).toContain('not used');
  });
});
