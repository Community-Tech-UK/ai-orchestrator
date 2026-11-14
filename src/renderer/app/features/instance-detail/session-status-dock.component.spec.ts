import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AggregatedReview } from '../../../../shared/types/cross-model-review.types';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { IpcFacadeService, VcsIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { SessionStatusDockComponent } from './session-status-dock.component';
import { buildDockRows, type DockToast } from './session-status-dock.rules';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

const review: AggregatedReview = {
  id: 'review-1',
  instanceId: 'inst-1',
  outputType: 'code',
  reviewDepth: 'structured',
  reviews: [],
  hasDisagreement: false,
  timestamp: 1,
} as unknown as AggregatedReview;

const toast = (id: string, type: DockToast['type'], message = id): DockToast => ({ id, type, message });

describe('buildDockRows', () => {
  it('puts failures first, then the compaction note, then plain results, each in arrival order', () => {
    const rows = buildDockRows({
      compactingText: 'compacting',
      toasts: [toast('a', 'info'), toast('b', 'error'), toast('c', 'info'), toast('d', 'error')],
    });
    expect(rows.map((row) => row.id)).toEqual(['b', 'd', 'compacting', 'a', 'c']);
    expect(rows.map((row) => row.kind)).toEqual(['error', 'error', 'compacting', 'info', 'info']);
  });

  it('is empty with nothing to say', () => {
    expect(buildDockRows({ compactingText: null, toasts: [] })).toEqual([]);
  });
});

describe('SessionStatusDockComponent (the one strip above the message box)', () => {
  let fixture: ComponentFixture<SessionStatusDockComponent>;
  const listSessionSnapshots = vi.fn(
    (): Promise<{ success: boolean; data: unknown[] }> => Promise.resolve({ success: true, data: [] }),
  );

  async function createDock(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [SessionStatusDockComponent],
      providers: [
        { provide: HistoryIpcService, useValue: { listSessionSnapshots, resumeSession: vi.fn() } },
        { provide: IpcFacadeService, useValue: { getApi: () => undefined } },
        { provide: VcsIpcService, useValue: { vcsIsRepo: vi.fn(), vcsGetStatus: vi.fn() } },
        { provide: InstanceStore, useValue: { instanceActivities: signal(new Map()), getInstance: () => undefined } },
        { provide: CrossModelReviewIpcService, useValue: { dismiss: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionStatusDockComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.detectChanges();
  }

  async function settle(): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    fixture.detectChanges();
  }

  const strip = (): HTMLElement | null => fixture.nativeElement.querySelector('.session-status-dock');

  it('renders nothing for a session with no row, chip or open second opinion', async () => {
    await createDock();
    await settle();
    expect(strip()).toBeNull();
  });

  it('shows the compaction note and result toasts as one-line rows, failures first', async () => {
    await createDock();
    fixture.componentRef.setInput('compactingText', 'Claude is compacting context.');
    fixture.componentRef.setInput('toasts', [toast('ok', 'info', 'Resumed.'), toast('bad', 'error', 'Quick action failed.')]);
    await settle();

    const rows = Array.from(fixture.nativeElement.querySelectorAll('.dock-row')) as HTMLElement[];
    expect(rows.map((row) => row.getAttribute('data-row-kind'))).toEqual(['error', 'compacting', 'info']);
    expect(rows[0].getAttribute('role')).toBe('alert');
    expect(rows[1].getAttribute('role')).toBe('status');
    expect(rows[0].textContent).toContain('Quick action failed.');
    // A row alone is enough to show the strip, with no chips.
    expect(fixture.nativeElement.querySelector('.dock-chips')).toBeNull();
  });

  it('opens the second opinion inside the strip only when asked, and adds no chip for it', async () => {
    await createDock();
    fixture.componentRef.setInput('secondOpinion', review);
    await settle();
    expect(strip()).toBeNull();

    fixture.componentRef.setInput('secondOpinionOpen', true);
    await settle();
    expect(strip()?.querySelector('app-cross-model-review-panel')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.dock-chips')).toBeNull();

    fixture.componentRef.setInput('secondOpinionOpen', false);
    await settle();
    expect(strip()).toBeNull();
  });

  it('shows no second opinion when it is open but the session has no review', async () => {
    await createDock();
    fixture.componentRef.setInput('secondOpinionOpen', true);
    await settle();
    expect(strip()).toBeNull();
  });

  it('shows chips only when they have content', async () => {
    await createDock();
    await settle();
    expect(fixture.nativeElement.querySelector('[data-chip-id]')).toBeNull();

    fixture.componentRef.setInput('childrenIds', ['child-1']);
    await settle();
    expect(fixture.nativeElement.querySelector('[data-chip-id="agents"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-chip-id="review"]')).toBeNull();
  });
});
