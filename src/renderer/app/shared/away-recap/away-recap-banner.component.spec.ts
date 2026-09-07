/**
 * N12 wiring. `away-recap.ts` was the one module in this wave with zero callers
 * — a data file, not a feature. These prove the banner reaches main and behaves
 * sensibly around the boundary it keeps.
 */
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AwayRecapBannerComponent } from './away-recap-banner.component';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';

await resolveComponentResources(() => Promise.resolve(''));

const RECAP = {
  cards: [{
    runId: 'r1', goal: 'Fix the login flow', outcome: 'needs-you' as const,
    status: 'error', iterations: 4, durationMs: 1_000, costCents: 25,
    outstandingCount: 2, endReason: 'boom',
  }],
  finished: 0, stoppedShort: 0, needsYou: 1, totalCostCents: 25,
  headline: '1 loop run ended: 1 needs you.',
};

function mount(getAwayRecap = vi.fn(async () => ({ success: true, data: { recap: RECAP } }))) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AwayRecapBannerComponent],
    providers: [{ provide: LoopIpcService, useValue: { getAwayRecap } }],
  });
  const fixture = TestBed.createComponent(AwayRecapBannerComponent);
  fixture.detectChanges();
  return { fixture, getAwayRecap };
}

async function focus(fixture: ComponentFixture<AwayRecapBannerComponent>) {
  window.dispatchEvent(new Event('focus'));
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AwayRecapBannerComponent (N12)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows nothing before the window has been refocused', () => {
    expect(mount().fixture.nativeElement.querySelector('.away-recap')).toBeNull();
  });

  it('asks main for a recap on focus and renders it', async () => {
    const { fixture, getAwayRecap } = mount();
    await focus(fixture);
    expect(getAwayRecap).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('1 needs you');
    expect(fixture.nativeElement.textContent).toContain('Fix the login flow');
  });

  /** Outcome must be readable without colour. */
  it('prints the outcome word on each card', async () => {
    const { fixture } = mount();
    await focus(fixture);
    expect(fixture.nativeElement.querySelector('.away-recap__outcome').textContent.trim())
      .toBe('Needs you');
  });

  it('surfaces open questions so they are not lost', async () => {
    const { fixture } = mount();
    await focus(fixture);
    expect(fixture.nativeElement.textContent).toContain('2 open questions');
  });

  /** A null recap means "nothing ended" — it must not clear an unread banner. */
  it('does not clear an existing banner when the next focus finds nothing', async () => {
    const getAwayRecap = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { recap: RECAP } })
      .mockResolvedValueOnce({ success: true, data: { recap: null } });
    const { fixture } = mount(getAwayRecap);
    await focus(fixture);
    await focus(fixture);
    expect(fixture.nativeElement.querySelector('.away-recap')).toBeTruthy();
  });

  it('stays silent when the bridge is unavailable rather than rendering an empty box', async () => {
    const { fixture } = mount(vi.fn(async () => ({
      success: false, error: { message: 'bridge unavailable' },
    })) as never);
    await focus(fixture);
    expect(fixture.nativeElement.querySelector('.away-recap')).toBeNull();
  });

  it('dismisses, and the same runs do not come back on the next focus', async () => {
    const getAwayRecap = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { recap: RECAP } })
      .mockResolvedValueOnce({ success: true, data: { recap: null } });
    const { fixture } = mount(getAwayRecap);
    await focus(fixture);
    fixture.nativeElement.querySelector('.away-recap__dismiss').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.away-recap')).toBeNull();

    await focus(fixture);
    expect(fixture.nativeElement.querySelector('.away-recap')).toBeNull();
  });

  it('advances the boundary so a second focus asks about a later window', async () => {
    const calls: number[] = [];
    const getAwayRecap = vi.fn(async (since: number) => {
      calls.push(since);
      return { success: true, data: { recap: RECAP } };
    });
    const { fixture } = mount(getAwayRecap as never);
    await focus(fixture);
    await focus(fixture);
    expect(calls).toHaveLength(2);
    expect(calls[1]!).toBeGreaterThanOrEqual(calls[0]!);
  });
  /**
   * The gate's finding: the boundary advances past a run the moment it is shown,
   * so a recap that gets REPLACED rather than merged is gone for good. The
   * "advances the boundary" test above drives this exact path but only asserts
   * the timestamps, so it passed while the data was being dropped.
   */
  it('keeps an unread recap when a later one arrives instead of overwriting it', async () => {
    const SECOND = {
      cards: [{
        runId: 'r2', goal: 'Ship the docs', outcome: 'finished' as const,
        status: 'completed', iterations: 2, durationMs: 500, costCents: 10,
        outstandingCount: 0, endReason: null,
      }],
      finished: 1, stoppedShort: 0, needsYou: 0, totalCostCents: 10,
      headline: '1 loop run ended: 1 finished.',
    };
    const getAwayRecap = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { recap: RECAP } })
      .mockResolvedValueOnce({ success: true, data: { recap: SECOND } });
    const { fixture } = mount(getAwayRecap);

    await focus(fixture);
    await focus(fixture);

    const goals = [...fixture.nativeElement.querySelectorAll('.away-recap__goal')]
      .map((el: Element) => el.textContent?.trim());
    // Both, and the urgent one first — not r2 alone.
    expect(goals).toEqual(['Fix the login flow', 'Ship the docs']);
    expect(fixture.nativeElement.querySelector('.away-recap__headline').textContent)
      .toContain('2 loop runs ended');
  });

  it('does not duplicate a run reported in both recaps', async () => {
    const getAwayRecap = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { recap: RECAP } })
      .mockResolvedValueOnce({ success: true, data: { recap: RECAP } });
    const { fixture } = mount(getAwayRecap);
    await focus(fixture);
    await focus(fixture);
    expect(fixture.nativeElement.querySelectorAll('.away-recap__card')).toHaveLength(1);
  });

  it('dismissing clears the merged banner, not just the newest card', async () => {
    const SECOND = { ...RECAP, cards: [{ ...RECAP.cards[0]!, runId: 'r2' }] };
    const getAwayRecap = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { recap: RECAP } })
      .mockResolvedValueOnce({ success: true, data: { recap: SECOND } });
    const { fixture } = mount(getAwayRecap);
    await focus(fixture);
    await focus(fixture);
    expect(fixture.nativeElement.querySelectorAll('.away-recap__card')).toHaveLength(2);
    fixture.nativeElement.querySelector('.away-recap__dismiss').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.away-recap')).toBeNull();
  });
});
