import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueNeedJamesRecord } from '../../../core/state/plan-queue.store';
import { PlanQueueNeedJamesListComponent } from './plan-queue-need-james-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-need-james-list.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-need-james-list.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-need-james-list.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-need-james-list.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('PlanQueueNeedJamesListComponent', () => {
  let fixture: ComponentFixture<PlanQueueNeedJamesListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PlanQueueNeedJamesListComponent] }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueNeedJamesListComponent);
  });

  it('shows an empty message with no records and no policy-gated count', () => {
    fixture.componentRef.setInput('records', []);
    fixture.componentRef.setInput('policyGatedCount', 0);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No open livetest checks need you right now');
  });

  it('groups records by run and shows each check with its document and reason', () => {
    const records: PlanQueueNeedJamesRecord[] = [
      { runId: 'run-a', itemId: 'item-1', documentPath: 'docs/livetest_1.md', check: 'Manual UI verify', reason: 'Needs a rebuilt app' },
      { runId: 'run-a', itemId: 'item-2', documentPath: 'docs/livetest_2.md', check: 'External service call', reason: 'Needs live credentials' },
      { runId: 'run-b', itemId: 'item-3', documentPath: 'docs/livetest_3.md', check: 'Mobile build', reason: 'Needs a device' },
    ];
    fixture.componentRef.setInput('records', records);
    fixture.componentRef.setInput('policyGatedCount', 0);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.pq-need-james-run')).toHaveLength(2);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Manual UI verify');
    expect(text).toContain('Needs a rebuilt app');
    expect(text).toContain('Mobile build');
  });

  it('shows the policy-gated count as a separate note', () => {
    fixture.componentRef.setInput('records', []);
    fixture.componentRef.setInput('policyGatedCount', 3);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('3 further check(s) are policy-gated');
  });
});
