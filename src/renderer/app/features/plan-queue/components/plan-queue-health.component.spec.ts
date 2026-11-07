import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from '@angular/router';
import type { PlanQueueHealth } from '@contracts/schemas/plan-queue';
import { PlanQueueHealthComponent } from './plan-queue-health.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-health.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-health.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-health.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-health.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const NOTHING = { count: 0, of: 0, share: null };
const empty: PlanQueueHealth = {
  windowDays: 14, since: 0, attemptsLanded: NOTHING, documentsLanded: NOTHING, passesNotLanded: NOTHING, firstCheckPassed: NOTHING,
  freeSlotToStart: { count: 0, medianMs: null }, checkTime: { count: 0, medianMs: null },
  landingTime: { count: 0, medianMs: null, syncMs: null, mergeCheckMs: null, commitCheckMs: null, publishMs: null },
  waiting: { waitingMs: 0, workingMs: 0, share: null }, setAsideRounds: { items: 0, rounds: 0 }, repeatFailingTests: [], lateFindings: { critical: 0, high: 0, medium: 0, low: 0 },
};

describe('PlanQueueHealthComponent', () => {
  let fixture: ComponentFixture<PlanQueueHealthComponent>;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PlanQueueHealthComponent] }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueHealthComponent);
  });

  it('says it is not available before any figures arrive', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Not available yet.');
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('lists each measure as a label with its value, and says when nothing is measured', () => {
    fixture.componentRef.setInput('health', empty);
    fixture.detectChanges();
    const rows = Array.from(fixture.nativeElement.querySelectorAll('.pq-health-row') as NodeListOf<HTMLElement>)
      .map(row => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent]);
    expect(rows.map(row => row[0])).toEqual([
      'Attempts that land', 'Documents that land', 'Passed checks that did not land', 'Passed the first check',
      'Wait from a free slot to the next start', 'Time a check takes', 'Time to land',
      'Time spent waiting rather than working', 'Rounds spent on items that were set aside', 'Tests failing in more than one job', 'New findings from round 3 on',
    ]);
    expect(rows[0][1]).toBe('Nothing measured yet');
    expect(rows[8][1]).toBe('None');
  });

  it('links to where work runs only when there is a test machine', () => {
    fixture.componentRef.setInput('health', empty);
    fixture.detectChanges();
    const labels = () => Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).map(button => button.textContent?.trim());
    expect(labels()).toEqual(['Refresh']);

    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentRef.setInput('health', {
      ...empty, testMachine: { label: 'the Windows PC', ranThere: NOTHING, movedToMac: NOTHING, unreachable: false },
    });
    fixture.detectChanges();
    expect(labels()).toEqual(['Refresh', 'Choose where work runs']);
    (fixture.nativeElement.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(navigate).toHaveBeenCalledWith(['/settings'], { queryParams: { tab: 'remote-nodes' } });
  });

  it('shows no notice while tests run where they should', () => {
    fixture.componentRef.setInput('health', {
      ...empty, testMachine: { label: 'the Windows PC', ranThere: NOTHING, movedToMac: NOTHING, unreachable: false },
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-health-notice')).toBeNull();
  });

  it('says so, as a status message, when tests have moved to the Mac', () => {
    fixture.componentRef.setInput('health', {
      ...empty, testMachine: { label: 'the Windows PC', ranThere: NOTHING, movedToMac: NOTHING, unreachable: true },
    });
    fixture.detectChanges();
    const notice = fixture.nativeElement.querySelector('.pq-health-notice') as HTMLElement;
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain("the Windows PC can't be reached");
  });

  it('asks for a refresh', () => {
    fixture.componentRef.setInput('health', empty);
    fixture.detectChanges();
    let refreshed = 0;
    fixture.componentInstance.refresh.subscribe(() => { refreshed++; });
    (fixture.nativeElement.querySelector('.pq-health-refresh') as HTMLButtonElement).click();
    expect(refreshed).toBe(1);
  });
});
