/**
 * N3 — the card, rendered.
 *
 * The load-bearing test is the empty-scores one: `{}` is truthy in JS, and
 * `selectWinner` returns exactly `scores: {}` for "no candidate passed verify"
 * — probably the most common outcome — so a truthiness check would render an
 * empty list every time that happened.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { LoopBranchEpisodeCardComponent } from './loop-branch-episode-card.component';
import { LoopStore } from '../../core/state/loop.store';
import type { LoopBranchEpisode } from '../../core/state/loop-store-branch-episodes';

await resolveComponentResources(() => Promise.resolve(''));

const episode = (over: Partial<LoopBranchEpisode> = {}): LoopBranchEpisode => ({
  loopRunId: 'loop-1',
  seq: 3,
  adopted: true,
  reason: 'candidate 2 passed verify',
  candidateCount: 4,
  winnerProvider: 'codex',
  ...over,
});

@Component({
  standalone: true,
  imports: [LoopBranchEpisodeCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-loop-branch-episode-card [loopRunId]="'loop-1'" [seq]="3" />`,
})
class HostComponent {}

describe('LoopBranchEpisodeCardComponent (N3)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let current: ReturnType<typeof signal<LoopBranchEpisode | null>>;

  beforeEach(async () => {
    current = signal<LoopBranchEpisode | null>(null);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: LoopStore, useValue: { branchEpisodeFor: () => current() } }],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  function card(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.branch-episode');
  }
  function set(ep: LoopBranchEpisode | null): void {
    current.set(ep);
    fixture.detectChanges();
  }

  /** The usual case: branch-select is opt-in and only fires on a CRITICAL stall. */
  it('renders nothing when no round ran for this iteration', () => {
    expect(card()).toBeNull();
  });

  it('says whether a candidate was adopted', () => {
    set(episode());
    expect(card()?.textContent).toContain('Adopted a candidate');
    expect(card()?.getAttribute('data-adopted')).toBe('true');
  });

  it('says so in words when nothing was adopted, not just by colour', () => {
    set(episode({ adopted: false, reason: 'no candidate passed verify' }));
    expect(card()?.textContent).toContain('Adopted nothing');
    expect(card()?.textContent).toContain('no candidate passed verify');
  });

  it('shows how many candidates ran', () => {
    set(episode());
    expect(card()?.textContent).toContain('4');
  });

  it('names the winning provider when there was one', () => {
    set(episode());
    expect(card()?.textContent).toContain('codex');
  });

  it('shows the round’s cost when the provider reported it', () => {
    set(episode({ totalCostUsd: 1.234 }));
    expect(card()?.textContent).toContain('$1.23');
  });

  /** Every candidate ran a real CLI turn, so "$0.00" would be a lie. */
  it('says "not reported" rather than $0.00 when no cost is known', () => {
    set(episode());
    expect(card()?.textContent).toContain('not reported');
    expect(card()?.textContent).not.toContain('$0.00');
  });

  it('lists the scores when there are any', () => {
    set(episode({ scores: { 'cand-1': 0.8, 'cand-2': 0.2 } }));
    const rows = fixture.nativeElement.querySelectorAll('.branch-episode__scores li');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('cand-1');
  });

  /**
   * `{}` is truthy. `selectWinner`'s "no candidate passed verify" path returns
   * exactly this, so a truthiness check renders an empty list on the most
   * common failure.
   */
  it('renders no score list at all for an empty scores object', () => {
    set(episode({ adopted: false, scores: {} }));
    expect(fixture.nativeElement.querySelector('.branch-episode__scores')).toBeNull();
    expect(card()).not.toBeNull();
  });

  it('renders no score list when scores are absent', () => {
    set(episode({ scores: undefined }));
    expect(fixture.nativeElement.querySelector('.branch-episode__scores')).toBeNull();
  });
});
