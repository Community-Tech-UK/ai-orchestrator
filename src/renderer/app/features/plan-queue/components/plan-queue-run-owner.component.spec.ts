import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { PlanQueueRunOwnerComponent, type PlanQueueSessionOption } from './plan-queue-run-owner.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-run-owner.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-run-owner.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-run-owner.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-run-owner.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeRun(overrides: Partial<PlanQueueRunDto> = {}): PlanQueueRunDto {
  return {
    id: 'run-1', parentInstanceId: 'owner', kind: 'plans', workspaceCwd: '/repo', status: 'running',
    config: { workerSlots: 3, verificationSlots: 2, maxRounds: 3, maxLoadAverage: 30, postMergeGate: [], verifierGates: [], relaxSettings: false },
    workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null, items: [],
    ...overrides,
  };
}

const SESSIONS: PlanQueueSessionOption[] = [
  { id: 'owner', label: 'Owner (codex) — /repo', canBeParent: true },
  { id: 'other', label: 'Other (claude) — /repo', canBeParent: true },
  { id: 'failed', label: 'Failed (claude) — /repo', canBeParent: false },
];

describe('PlanQueueRunOwnerComponent', () => {
  let fixture: ComponentFixture<PlanQueueRunOwnerComponent>;
  let control: ReturnType<typeof vi.fn>;

  async function render(run: PlanQueueRunDto, sessions = SESSIONS): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [PlanQueueRunOwnerComponent],
      providers: [{ provide: PlanQueueIpcService, useValue: { control } }],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueRunOwnerComponent);
    fixture.componentRef.setInput('run', run);
    fixture.componentRef.setInput('sessions', sessions);
    fixture.detectChanges();
  }

  const element = () => fixture.nativeElement as HTMLElement;
  const button = (selector: string) => element().querySelector(selector) as HTMLButtonElement;
  const select = () => element().querySelector('select') as HTMLSelectElement;
  async function open(): Promise<void> {
    button('.pq-run-owner-change').click();
    fixture.detectChanges();
    await fixture.whenStable();
  }
  function choose(id: string): void {
    select().value = id;
    select().dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }
  async function confirm(): Promise<void> {
    button('.pq-run-owner-confirm').click();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    control = vi.fn().mockResolvedValue({ success: true, data: null });
  });

  it('names the parent session, or says it is no longer open', async () => {
    await render(makeRun());
    expect(element().textContent).toContain('Parent session: Owner (codex) — /repo');
    fixture.componentRef.setInput('run', makeRun({ parentInstanceId: 'gone' }));
    fixture.detectChanges();
    expect(element().textContent).toContain('Parent session: a session that is no longer open');
  });

  it('names an owner that cannot take a run itself, such as a helper session', async () => {
    await render(makeRun({ parentInstanceId: 'failed' }));
    expect(element().textContent).toContain('Parent session: Failed (claude) — /repo');
  });

  it('offers only other sessions that can take the run, moves it, and returns focus to the button', async () => {
    await render(makeRun({ status: 'paused' }));
    await open();
    expect(document.activeElement).toBe(select());
    expect(Array.from(select().options).map(option => option.value)).toEqual(['', 'other']);

    button('.pq-run-owner-confirm').click();
    expect(control).not.toHaveBeenCalled();
    expect(button('.pq-run-owner-confirm').getAttribute('aria-disabled')).toBe('true');

    choose('other');
    await confirm();
    expect(control).toHaveBeenCalledWith({ action: 'handover', runId: 'run-1', targetInstanceId: 'other' });
    expect(element().querySelector('select')).toBeNull();
    expect(document.activeElement).toBe(button('.pq-run-owner-change'));
  });

  it('keeps the choice open and shows the reason beside it when the move is refused', async () => {
    control.mockResolvedValue({ success: false, error: { message: 'Pause this run first' } });
    await render(makeRun());
    await open();
    choose('other');
    button('.pq-run-owner-confirm').focus();
    await confirm();
    expect(select().value).toBe('other');
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('Pause this run first');
    expect(document.activeElement).toBe(button('.pq-run-owner-confirm'));
  });

  it('shows Moving… and sends one move however often Move is pressed while it runs', async () => {
    let finish!: (value: unknown) => void;
    control.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render(makeRun());
    await open();
    choose('other');
    button('.pq-run-owner-confirm').click();
    fixture.detectChanges();
    expect(button('.pq-run-owner-confirm').textContent?.trim()).toBe('Moving…');
    button('.pq-run-owner-confirm').click();
    expect(control).toHaveBeenCalledTimes(1);
    finish({ success: false });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('The run could not be moved.');
  });

  it('disables Move when the chosen session closes before James confirms', async () => {
    await render(makeRun());
    await open();
    choose('other');
    fixture.componentRef.setInput('sessions', SESSIONS.filter(session => session.id !== 'other'));
    fixture.detectChanges();
    expect(button('.pq-run-owner-confirm').getAttribute('aria-disabled')).toBe('true');
    button('.pq-run-owner-confirm').click();
    expect(control).not.toHaveBeenCalled();
  });

  it('shows a failed call beside Move rather than losing it', async () => {
    control.mockRejectedValue(new Error('Not in Electron'));
    await render(makeRun());
    await open();
    choose('other');
    await confirm();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('Not in Electron');
    expect(button('.pq-run-owner-confirm').textContent?.trim()).toBe('Move');
  });

  it('closes the choice when the run finishes, so it does not reopen with a stale choice', async () => {
    await render(makeRun());
    await open();
    choose('other');
    fixture.componentRef.setInput('run', makeRun({ status: 'completed' }));
    fixture.detectChanges();
    fixture.componentRef.setInput('run', makeRun({ status: 'running' }));
    fixture.detectChanges();
    expect(element().querySelector('select')).toBeNull();
    await open();
    expect(select().value).toBe('');
  });

  it('says a sleeping session wakes, and asks for a pause only while the run is running', async () => {
    await render(makeRun());
    await open();
    const note = () => element().querySelector('.pq-run-owner-note')?.textContent ?? '';
    expect(note().replace(/\s+/g, ' ')).toContain('A session that is asleep wakes up to take it over.');
    expect(element().querySelector('.pq-run-owner-note app-term')?.textContent?.trim()).toBe('asleep');
    expect(note()).toContain('Pause the run first');
    expect(button('.pq-run-owner-confirm').getAttribute('aria-describedby')).toBe(element().querySelector('.pq-run-owner-note')?.id);
    fixture.componentRef.setInput('run', makeRun({ status: 'paused' }));
    fixture.detectChanges();
    expect(note()).not.toContain('Pause the run first');
  });

  it('closes the choice with Never mind and moves nothing', async () => {
    await render(makeRun());
    await open();
    const neverMind = Array.from(element().querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === 'Never mind')!;
    neverMind.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element().querySelector('select')).toBeNull();
    expect(control).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('.pq-run-owner-change'));
  });

  it('explains why Move is unavailable when no other session can take the run', async () => {
    await render(makeRun(), SESSIONS.filter(session => session.id !== 'other'));
    expect(button('.pq-run-owner-change').getAttribute('aria-disabled')).toBe('true');
    button('.pq-run-owner-change').click();
    fixture.detectChanges();
    expect(element().querySelector('select')).toBeNull();
  });

  it('shows nothing for a finished run with nothing set aside, and offers Move while it holds set-aside work', async () => {
    await render(makeRun({ status: 'completed' }));
    expect(element().querySelector('.pq-run-owner')).toBeNull();
    const parked = { id: 'item', runId: 'run-1', documentPath: 'docs/plans/a_plan.md', state: 'parked' as const, round: 3, erroredRounds: 0,
      branchName: 'queue/a', worktreePath: null, baseCommit: null, checkpointCommit: null, landedCommit: null, workerInstanceId: null,
      verifierInstanceId: null, question: null, answer: null, parkReason: 'round-limit' as const, detail: null, verdict: null, createdAt: 1, updatedAt: 1 };
    fixture.componentRef.setInput('run', makeRun({ status: 'completed', items: [parked] }));
    fixture.detectChanges();
    expect(element().textContent).toContain('Parent session: Owner (codex) — /repo');
    await open();
    choose('other');
    await confirm();
    expect(control).toHaveBeenCalledWith({ action: 'handover', runId: 'run-1', targetInstanceId: 'other' });
  });
});
