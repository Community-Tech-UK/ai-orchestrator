import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopStore } from '../../core/state/loop.store';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { WorkboardCardComponent } from './workboard-card.component';
import { WorkboardStore } from './workboard.store';
import type { WorkboardItem, WorkboardPendingActionRequest } from './workboard.types';

// `WorkboardCardComponent` uses `styleUrl` (external resource); empty it so
// TestBed never needs the real filesystem read, matching the pattern in
// `workboard-page.component.spec.ts`.
await resolveComponentResources(() => Promise.resolve(''));

const NOW = 1_700_000_000_000;

function item(overrides: Partial<WorkboardItem> = {}): WorkboardItem {
  const kind = overrides.primary?.kind ?? 'instance';
  return {
    id: overrides.id ?? `${kind}:x`,
    primary: {
      kind,
      id: 'x',
      rawStatus: 'busy',
      phase: 'running',
      lane: 'working',
      attentionLevel: 'working',
      updatedAt: NOW,
      terminal: false,
    },
    relations: [],
    lane: 'working',
    attentionLevel: 'working',
    title: 'Build session',
    workspaceId: '/repo/project',
    workingDirectory: '/repo/project',
    statusLabel: 'Busy',
    updatedAt: NOW,
    instanceId: 'inst-1',
    ...overrides,
  };
}

function actionRequest(overrides: Partial<WorkboardPendingActionRequest> = {}): WorkboardPendingActionRequest {
  return { id: 'req-1', instanceId: 'inst-1', requestType: 'approve_action', ...overrides };
}

describe('WorkboardCardComponent', () => {
  let fixture: ComponentFixture<WorkboardCardComponent>;
  let listUserActionRequestsForInstance: ReturnType<typeof vi.fn>;
  let respondToUserAction: ReturnType<typeof vi.fn>;
  let resume: ReturnType<typeof vi.fn>;
  let snoozedIds: ReturnType<typeof signal<ReadonlySet<string>>>;
  let snoozeItem: ReturnType<typeof vi.fn>;
  let unsnoozeItem: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    listUserActionRequestsForInstance = vi.fn(async () => ({ success: true, data: [] }));
    respondToUserAction = vi.fn(async () => ({ success: true }));
    resume = vi.fn(async () => undefined);
    // A real signal (not a plain vi.fn) so the card's `computed(() =>
    // store.isSnoozed(...))` — which reads this signal indirectly — actually
    // participates in Angular's reactivity, matching the real WorkboardStore.
    snoozedIds = signal<ReadonlySet<string>>(new Set());
    snoozeItem = vi.fn((id: string) => snoozedIds.set(new Set(snoozedIds()).add(id)));
    unsnoozeItem = vi.fn((id: string) => {
      const next = new Set(snoozedIds());
      next.delete(id);
      snoozedIds.set(next);
    });
    const isSnoozed = (id: string) => snoozedIds().has(id);

    await TestBed.configureTestingModule({
      imports: [WorkboardCardComponent],
      providers: [
        { provide: InstanceIpcService, useValue: { listUserActionRequestsForInstance, respondToUserAction } },
        { provide: LoopStore, useValue: { resume } },
        { provide: WorkboardStore, useValue: { isSnoozed, snoozeItem, unsnoozeItem } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkboardCardComponent);
  });

  it('never nests a button inside the main clickable button (valid HTML, no swallowed clicks)', async () => {
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.wb-card button')).toBeNull();
    // The action row (snooze, at minimum) sits as a sibling, not a descendant.
    expect(fixture.nativeElement.querySelector('.wb-card-snooze')).not.toBeNull();
  });

  it('does not show Approve/Reject for a non-blocked item, and never calls the IPC bridge', async () => {
    fixture.componentRef.setInput('item', item({ attentionLevel: 'working' }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(listUserActionRequestsForInstance).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.wb-card-action-approve')).toBeNull();
  });

  it('shows Approve/Reject for a blocked item with a pending approve_action request', async () => {
    listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [actionRequest()] });
    fixture.componentRef.setInput('item', item({ attentionLevel: 'blocked' }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(listUserActionRequestsForInstance).toHaveBeenCalledWith('inst-1');
    const approve = fixture.nativeElement.querySelector('.wb-card-action-approve') as HTMLButtonElement;
    const reject = fixture.nativeElement.querySelector('.wb-card-action-reject') as HTMLButtonElement;
    expect(approve).not.toBeNull();
    expect(reject).not.toBeNull();
  });

  it('does not show Approve/Reject when the only pending request needs a chosen option', async () => {
    listUserActionRequestsForInstance.mockResolvedValue({
      success: true,
      data: [actionRequest({ requestType: 'select_option' })],
    });
    fixture.componentRef.setInput('item', item({ attentionLevel: 'blocked' }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.wb-card-action-approve')).toBeNull();
  });

  it('approving dispatches respondToUserAction(id, true) and hides the buttons afterward', async () => {
    listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [actionRequest()] });
    fixture.componentRef.setInput('item', item({ attentionLevel: 'blocked' }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const approve = fixture.nativeElement.querySelector('.wb-card-action-approve') as HTMLButtonElement;
    approve.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(respondToUserAction).toHaveBeenCalledWith('req-1', true);
    expect(fixture.nativeElement.querySelector('.wb-card-action-approve')).toBeNull();
  });

  it('rejecting dispatches respondToUserAction(id, false)', async () => {
    listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [actionRequest()] });
    fixture.componentRef.setInput('item', item({ attentionLevel: 'blocked' }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const reject = fixture.nativeElement.querySelector('.wb-card-action-reject') as HTMLButtonElement;
    reject.click();
    await fixture.whenStable();

    expect(respondToUserAction).toHaveBeenCalledWith('req-1', false);
  });

  it('shows Resume only for a waiting, paused/provider-limit loop-run primary', async () => {
    fixture.componentRef.setInput(
      'item',
      item({
        primary: {
          kind: 'loop-run', id: 'loop-1', rawStatus: 'paused', phase: 'blocked',
          lane: 'waiting', attentionLevel: 'waiting', updatedAt: NOW, terminal: false,
        },
        lane: 'waiting',
        attentionLevel: 'waiting',
        loopRunId: 'loop-1',
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const resumeButton = fixture.nativeElement.querySelector('.wb-card-action-resume') as HTMLButtonElement;
    expect(resumeButton).not.toBeNull();

    resumeButton.click();
    await fixture.whenStable();
    expect(resume).toHaveBeenCalledWith('loop-1');
  });

  it('does not show Resume for a waiting automation-run (resume only applies to loops)', async () => {
    fixture.componentRef.setInput(
      'item',
      item({
        primary: {
          kind: 'automation-run', id: 'run-1', rawStatus: 'pending', phase: 'pending',
          lane: 'waiting', attentionLevel: 'waiting', updatedAt: NOW, terminal: false,
        },
        lane: 'waiting',
        attentionLevel: 'waiting',
        automationRunId: 'run-1',
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.wb-card-action-resume')).toBeNull();
  });

  it('toggling snooze calls the store and reflects aria-pressed', async () => {
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const snooze = fixture.nativeElement.querySelector('.wb-card-snooze') as HTMLButtonElement;
    expect(snooze.getAttribute('aria-pressed')).toBe('false');
    snooze.click();
    expect(snoozeItem).toHaveBeenCalledWith(item().id);

    // The click above already flipped the underlying signal via `snoozeItem`;
    // re-render and confirm the card picks it up.
    fixture.detectChanges();
    expect(snooze.getAttribute('aria-pressed')).toBe('true');
    snooze.click();
    expect(unsnoozeItem).toHaveBeenCalledWith(item().id);
  });

  it('clicking an action button does not also activate the card (no bubbling select)', async () => {
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let activated = false;
    fixture.componentInstance.activate.subscribe(() => {
      activated = true;
    });

    const snooze = fixture.nativeElement.querySelector('.wb-card-snooze') as HTMLButtonElement;
    snooze.click();
    expect(activated).toBe(false);
  });
});
