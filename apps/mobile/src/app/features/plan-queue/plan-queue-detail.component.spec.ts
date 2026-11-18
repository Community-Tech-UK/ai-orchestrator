import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobilePlanQueueItemDto, MobilePlanQueueRunDto } from '../../core/models';
import { PlanQueueDetailComponent } from './plan-queue-detail.component';
import { PlanQueueComponent } from './plan-queue.component';
import { PlanQueueStore } from './plan-queue.store';

const DETAIL = 'Not landed: this job would undo a change made directly on the base branch on 15 Nov ("Quota strip codes", 234b7e405) in title-bar-quota.component.ts.';

function item(overrides: Partial<MobilePlanQueueItemDto> = {}): MobilePlanQueueItemDto {
  return {
    id: 'item-1', runId: 'run-1', title: 'phase-e_plan.md', sourceRef: '/repo/docs/plans/phase-e_plan.md',
    state: 'parked', round: 2, question: null, answer: null, parkReason: 'undoes-direct-change', detail: DETAIL,
    verdict: 'PASS', workerInstanceId: null, updatedAt: 1, ...overrides,
  };
}

function runWith(items: MobilePlanQueueItemDto[]): MobilePlanQueueRunDto {
  return { id: 'run-1', kind: 'plans', status: 'running', workspaceCwd: '/repo', startedAt: 0, endedAt: null,
    workerProvider: null, workerModel: null, items };
}

function gateway(items: MobilePlanQueueItemDto[]) {
  return {
    online: signal(true),
    planQueueEvent: signal(0),
    planQueue: vi.fn().mockResolvedValue({ runs: [runWith(items)] }),
    planQueueDiffstat: vi.fn().mockResolvedValue({ diffstat: '' }),
    choosePlanQueueDirectChange: vi.fn().mockResolvedValue({ ok: true }),
  };
}

let mounted: ComponentFixture<unknown> | null = null;

async function mount<T>(component: new (...args: never[]) => T, client: ReturnType<typeof gateway>, prepare?: (fixture: ComponentFixture<T>) => void): Promise<HTMLElement> {
  TestBed.configureTestingModule({
    imports: [component],
    providers: [
      { provide: GatewayClient, useValue: client },
      { provide: HostStore, useValue: { activeHost: signal({ id: 'host' }) } },
      { provide: Router, useValue: { navigate: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(component);
  mounted = fixture;
  prepare?.(fixture);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function buttonsOf(element: HTMLElement): HTMLButtonElement[] {
  return [...element.querySelectorAll('button')].filter((button) => button.textContent?.trim() !== '');
}

afterEach(() => TestBed.resetTestingModule());

describe('plan queue job that would undo a direct change, on the phone', () => {
  it.each([
    ['Keep that change', 'keep-change'],
    ["Take the job's version", 'take-job-version'],
  ])('shows the change and both choices, and "%s" sends %s', async (label, choice) => {
    const client = gateway([item()]);
    const element = await mount(PlanQueueDetailComponent, client, (fixture) => fixture.componentRef.setInput('id', 'item-1'));
    expect(element.querySelector('h2')?.textContent).toBe('Choose which version to keep');
    expect(element.textContent).toContain(DETAIL);
    const choices = buttonsOf(element).map((button) => button.textContent!.trim());
    expect(choices).toEqual(['Keep that change', "Take the job's version"]);
    buttonsOf(element).find((button) => button.textContent!.trim() === label)!.click();
    await vi.waitFor(() => expect(client.choosePlanQueueDirectChange).toHaveBeenCalledWith('item-1', choice));
    expect(client.choosePlanQueueDirectChange).toHaveBeenCalledTimes(1);
  });

  it('says what each choice does next to it, and passes axe', async () => {
    const element = await mount(PlanQueueDetailComponent, gateway([item()]), (fixture) => fixture.componentRef.setInput('id', 'item-1'));
    const take = buttonsOf(element).find((button) => button.textContent!.includes('job'))!;
    expect(element.querySelector(`#${take.getAttribute('aria-describedby')}`)?.textContent).toContain('undoes that change');
    const results = await axe.run(element, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('shows progress on the chosen button while the choice is sent', async () => {
    const client = gateway([item()]);
    let finish: () => void = () => undefined;
    client.choosePlanQueueDirectChange.mockReturnValue(new Promise((resolve) => { finish = () => resolve({ ok: true }); }));
    const element = await mount(PlanQueueDetailComponent, client, (fixture) => fixture.componentRef.setInput('id', 'item-1'));
    const store = TestBed.inject(PlanQueueStore);
    buttonsOf(element).find((button) => button.textContent!.includes('job'))!.click();
    await vi.waitFor(() => expect(store.pending()).toBe(true));
    mounted!.detectChanges();
    expect(buttonsOf(element).map((button) => [button.textContent!.trim(), button.disabled]))
      .toEqual([['Keep that change', true], ["Taking the job's version…", true]]);
    finish();
    await vi.waitFor(() => expect(store.pending()).toBe(false));
    await mounted!.whenStable();
    mounted!.detectChanges();
    expect(buttonsOf(element).map((button) => button.textContent!.trim())).toEqual(['Keep that change', "Take the job's version"]);
  });

  it('offers no choice for a job set aside for any other reason', async () => {
    const client = gateway([item({ parkReason: 'round-limit', detail: 'Ran out of rounds.' })]);
    const element = await mount(PlanQueueDetailComponent, client, (fixture) => fixture.componentRef.setInput('id', 'item-1'));
    expect(element.textContent).not.toContain('Keep that change');
    expect(buttonsOf(element)).toEqual([]);
  });

  it('marks the job in the list as needing a choice', async () => {
    const element = await mount(PlanQueueComponent, gateway([item(), item({ id: 'item-2', title: 'other_plan.md', parkReason: 'round-limit' })]));
    const states = [...element.querySelectorAll('li button span:last-child')].map((span) => span.textContent!.replace(/\s+/g, ' ').trim());
    expect(states).toEqual(['parked · needs your choice', 'parked']);
  });
});
