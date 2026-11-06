import { ComponentRef, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueRunControlsComponent } from './plan-queue-run-controls.component';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';

const specDirectory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-run-controls.component.html')) return Promise.resolve(readFileSync(resolve(specDirectory, './plan-queue-run-controls.component.html'), 'utf8'));
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const run = (overrides: Partial<PlanQueueRunDto> = {}) => ({ id: 'run', status: 'running', items: [], holdReason: null, ...overrides }) as unknown as PlanQueueRunDto;

describe('PlanQueueRunControlsComponent', () => {
  let ref: ComponentRef<PlanQueueRunControlsComponent>;
  let host: HTMLElement;
  const fixture = () => {
    const created = TestBed.createComponent(PlanQueueRunControlsComponent);
    ref = created.componentRef;
    host = created.nativeElement as HTMLElement;
    return created;
  };
  const resume = () => host.querySelector<HTMLButtonElement>('.pq-resume');

  beforeEach(() => TestBed.configureTestingModule({ imports: [PlanQueueRunControlsComponent] }));

  it('says why a held run has stopped starting work, and offers Resume', () => {
    const created = fixture();
    ref.setInput('run', run({ holdReason: 'No new work is starting: three jobs failed the same way.' }));
    created.detectChanges();
    expect(host.querySelector('.pq-run-status')?.textContent).toContain('On hold');
    expect(host.querySelector('.pq-run-hold')?.textContent).toContain('three jobs failed the same way');
    const emitted = vi.fn();
    created.componentInstance.resumeRun.subscribe(emitted);
    resume()!.click();
    expect(emitted).toHaveBeenCalledWith('run');
  });

  it('shows no Resume on a healthy running run', () => {
    const created = fixture();
    ref.setInput('run', run());
    created.detectChanges();
    expect(resume()).toBeNull();
  });

  it('explains that Pause saves work on each branch, on keyboard focus', () => {
    const created = fixture();
    ref.setInput('run', run());
    created.detectChanges();
    const button = host.querySelector('button') as HTMLButtonElement;
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.focus();
    created.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Stops this run’s sessions now and saves work on each document’s branch. Resume carries on from there.');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it.each([
    ['running', 'button', 'sessions now'],
    ['paused', '.pq-resume', 'once pausing has finished'],
    ['running', '.pq-cancel', 'Asks first, then stops'],
  ] as const)('opens the %s control explanation at %s', (status, selector, timing) => {
    const created = fixture();
    ref.setInput('run', run({ status }));
    created.detectChanges();
    const trigger = created.debugElement.query(By.css(selector));
    const tooltip = trigger.injector.get(AioTooltipDirective);
    tooltip.show();
    created.detectChanges();
    const panel = document.querySelector('[role="tooltip"]');
    expect(panel?.textContent).toContain(timing);
    expect(trigger.nativeElement.getAttribute('aria-describedby')).toBe(panel?.id);
    tooltip.hide();
  });
});
