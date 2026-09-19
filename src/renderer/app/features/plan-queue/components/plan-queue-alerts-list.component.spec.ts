import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueAlert } from '@contracts/schemas/plan-queue';
import { PlanQueueAlertsListComponent } from './plan-queue-alerts-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-alerts-list.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-alerts-list.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-alerts-list.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-alerts-list.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('PlanQueueAlertsListComponent', () => {
  let fixture: ComponentFixture<PlanQueueAlertsListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PlanQueueAlertsListComponent] }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueAlertsListComponent);
  });

  it('shows an empty message with no alerts', () => {
    fixture.componentRef.setInput('alerts', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No worktree or branch alerts');
  });

  it('renders each alert kind, path, branch, and item id when present', () => {
    const alerts: PlanQueueAlert[] = [
      { kind: 'unowned-worktree', path: '/tmp/wt-1' },
      { kind: 'unowned-branch', branchName: 'stray-branch', itemId: 'item-9' },
    ];
    fixture.componentRef.setInput('alerts', alerts);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Unowned worktree');
    expect(text).toContain('/tmp/wt-1');
    expect(text).toContain('Unowned branch');
    expect(text).toContain('stray-branch');
    expect(text).toContain('item item-9');
  });

  it('emits refresh when the button is clicked', () => {
    fixture.componentRef.setInput('alerts', []);
    fixture.detectChanges();
    let count = 0;
    fixture.componentInstance.refresh.subscribe(() => count++);

    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(count).toBe(1);
  });
});
