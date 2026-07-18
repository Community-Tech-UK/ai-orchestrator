import { Component, ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkboardPageComponent } from './workboard-page.component';

// The page uses inline template + styles, but it transitively imports
// InstanceDetailComponent (external templateUrl/styleUrl) before that import is
// swapped for a stub. TestBed still queues those defs for resolution, so empty
// every external resource; the real InstanceDetail never renders here.
await resolveComponentResources(() => Promise.resolve(''));
import { WorkboardStore } from './workboard.store';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { workboardSpecialistTarget } from './workboard-source-summary.component';
import type { WorkboardItem, WorkboardLanes } from './workboard.types';

const NOW = 1_700_000_000_000;

@Component({ selector: 'app-instance-detail', standalone: true, template: '<div class="stub-detail"></div>' })
class StubInstanceDetailComponent {}

function emptyLanes(): WorkboardLanes {
  return { 'needs-you': [], working: [], waiting: [], done: [] };
}

function item(overrides: Partial<WorkboardItem> = {}): WorkboardItem {
  const kind = overrides.primary?.kind ?? 'instance';
  const id = overrides.id ?? `${kind}:x`;
  return {
    id,
    primary: {
      kind,
      id: 'x',
      rawStatus: 'busy',
      phase: 'running',
      lane: 'working',
      updatedAt: NOW,
      terminal: false,
    },
    relations: [],
    lane: 'working',
    title: 'Build session',
    workspaceId: '/repo/project',
    workingDirectory: '/repo/project',
    statusLabel: 'Busy',
    updatedAt: NOW,
    ...overrides,
  };
}

function makeFakeStore() {
  const lanes = signal<WorkboardLanes>(emptyLanes());
  const selectedItemId = signal<string | null>(null);
  const selectedWorkboardItem = signal<WorkboardItem | null>(null);
  return {
    lanes,
    selectedItemId,
    selectedWorkboardItem,
    visibleCount: signal(0),
    selectedWorkspaceId: signal('all'),
    workspaceOptions: signal([
      { id: 'all', label: 'All workspaces', workingDirectory: '' },
      { id: '/repo/project', label: 'project', workingDirectory: '/repo/project' },
    ]),
    refreshing: signal(false),
    loopError: signal<string | null>(null),
    repoJobError: signal<string | null>(null),
    automationError: signal<string | null>(null),
    selectWorkspace: vi.fn(),
    selectItem: vi.fn((id: string) => selectedItemId.set(id)),
    clearSelection: vi.fn(() => {
      selectedItemId.set(null);
      selectedWorkboardItem.set(null);
    }),
    refresh: vi.fn(async () => { /* noop */ }),
    advanceClock: vi.fn(),
    retryLoops: vi.fn(async () => { /* noop */ }),
    retryRepoJobs: vi.fn(async () => { /* noop */ }),
    retryAutomations: vi.fn(async () => { /* noop */ }),
  };
}

describe('WorkboardPageComponent', () => {
  let store: ReturnType<typeof makeFakeStore>;
  let router: { navigateByUrl: ReturnType<typeof vi.fn> };

  async function render() {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(WorkboardPageComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    store = makeFakeStore();
    router = { navigateByUrl: vi.fn() };
    TestBed.configureTestingModule({
      imports: [WorkboardPageComponent],
      providers: [{ provide: Router, useValue: router }],
    });
    TestBed.overrideComponent(WorkboardPageComponent, {
      remove: { imports: [InstanceDetailComponent], providers: [WorkboardStore] },
      add: {
        imports: [StubInstanceDetailComponent],
        providers: [{ provide: WorkboardStore, useValue: store }],
      },
    });
  });

  it('renders the four lane headings in order even when empty', async () => {
    const fixture = await render();
    const headings = Array.from(
      fixture.nativeElement.querySelectorAll('.wb-lane-name'),
    ).map((el) => (el as HTMLElement).textContent?.trim());
    expect(headings).toEqual(['Needs You', 'Working', 'Waiting', 'Done / Idle']);
  });

  it('shows the specific empty-state text for each empty lane', async () => {
    const fixture = await render();
    const empties = Array.from(fixture.nativeElement.querySelectorAll('.wb-lane-empty')).map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(empties).toEqual(['All clear', 'Nothing active', 'Nothing queued or paused', 'No recent completions']);
  });

  it('renders counts and cards from the store lane selectors', async () => {
    const lanes = emptyLanes();
    lanes.working = [item({ id: 'instance:a', title: 'Alpha' })];
    lanes['needs-you'] = [
      item({
        id: 'repo-job:b',
        title: 'PR review',
        lane: 'needs-you',
        primary: { kind: 'repo-job', id: 'b', rawStatus: 'failed', phase: 'failed', lane: 'needs-you', updatedAt: NOW, terminal: true },
        statusLabel: 'Failed',
        progress: 80,
      }),
    ];
    store.lanes.set(lanes);
    const fixture = await render();

    const counts = Array.from(fixture.nativeElement.querySelectorAll('.wb-lane-count')).map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(counts).toEqual(['1', '1', '0', '0']);
    expect(fixture.nativeElement.textContent).toContain('Alpha');
    expect(fixture.nativeElement.textContent).toContain('PR review');
    // Card content: source badge + status + progress.
    expect(fixture.nativeElement.textContent).toContain('Repo job');
    expect(fixture.nativeElement.textContent).toContain('80%');
  });

  it('uses a native button root for each card (keyboard reachable, no custom handlers)', async () => {
    const lanes = emptyLanes();
    lanes.working = [item({ id: 'instance:a' })];
    store.lanes.set(lanes);
    const fixture = await render();
    const card = fixture.nativeElement.querySelector('app-workboard-card button');
    expect(card).toBeTruthy();
    expect((card as HTMLElement).tagName).toBe('BUTTON');
  });

  it('activating a card calls store.selectItem and exposes an accessible selected state', async () => {
    const lanes = emptyLanes();
    lanes.working = [item({ id: 'instance:a' })];
    store.lanes.set(lanes);
    store.selectedItemId.set('instance:a');
    const fixture = await render();

    const card = fixture.nativeElement.querySelector('app-workboard-card button') as HTMLButtonElement;
    expect(card.getAttribute('aria-pressed')).toBe('true');
    card.click();
    expect(store.selectItem).toHaveBeenCalledWith('instance:a');
  });

  it('delegates workspace selection to the store', async () => {
    const fixture = await render();
    const select = fixture.nativeElement.querySelector('.wb-workspace-select') as HTMLSelectElement;
    select.value = '/repo/project';
    select.dispatchEvent(new Event('change'));
    expect(store.selectWorkspace).toHaveBeenCalledWith('/repo/project');
  });

  it('renders a source-specific warning + Retry while other cards remain', async () => {
    const lanes = emptyLanes();
    lanes.working = [item({ id: 'instance:a', title: 'Alpha' })];
    store.lanes.set(lanes);
    store.loopError.set('store offline');
    const fixture = await render();

    expect(fixture.nativeElement.textContent).toContain('store offline');
    const retry = fixture.nativeElement.querySelector('.wb-source-error button') as HTMLButtonElement;
    expect(retry.textContent?.trim()).toBe('Retry');
    retry.click();
    expect(store.retryLoops).toHaveBeenCalled();
    // Other source cards still render.
    expect(fixture.nativeElement.textContent).toContain('Alpha');
  });

  it('keeps existing cards during a refresh (no empty-state swap)', async () => {
    const lanes = emptyLanes();
    lanes.working = [item({ id: 'instance:a', title: 'Alpha' })];
    store.lanes.set(lanes);
    store.refreshing.set(true);
    const fixture = await render();
    expect(fixture.nativeElement.textContent).toContain('Alpha');
    expect(fixture.nativeElement.querySelector('.wb-lane[data-lane="working"] .wb-lane-empty')).toBeNull();
  });

  // ── Task 7: detail pane ──

  it('shows a placeholder when nothing is selected', async () => {
    const fixture = await render();
    expect(fixture.nativeElement.querySelector('.wb-detail-placeholder')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-instance-detail')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-workboard-source-summary')).toBeNull();
  });

  it('renders the embedded instance transcript for an instance-linked selection only', async () => {
    store.selectedItemId.set('instance:a');
    store.selectedWorkboardItem.set(item({ id: 'instance:a', instanceId: 'inst-1' }));
    const fixture = await render();
    expect(fixture.nativeElement.querySelector('app-instance-detail')).toBeTruthy();
    // No second source-summary transcript implementation.
    expect(fixture.nativeElement.querySelector('app-workboard-source-summary')).toBeNull();
  });

  it('renders the source summary for a selection with no linked instance', async () => {
    store.selectedItemId.set('automation-run:r');
    store.selectedWorkboardItem.set(
      item({
        id: 'automation-run:r',
        instanceId: undefined,
        primary: { kind: 'automation-run', id: 'r', rawStatus: 'failed', phase: 'failed', lane: 'needs-you', updatedAt: NOW, terminal: true },
      }),
    );
    const fixture = await render();
    expect(fixture.nativeElement.querySelector('app-workboard-source-summary')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-instance-detail')).toBeNull();
  });

  it('navigates to the specialist route from the source summary', async () => {
    store.selectedItemId.set('repo-job:b');
    store.selectedWorkboardItem.set(
      item({
        id: 'repo-job:b',
        instanceId: undefined,
        primary: { kind: 'repo-job', id: 'b', rawStatus: 'failed', phase: 'failed', lane: 'needs-you', updatedAt: NOW, terminal: true },
      }),
    );
    const fixture = await render();
    const open = fixture.nativeElement.querySelector('.wb-summary-open') as HTMLButtonElement;
    open.click();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/tasks');
  });

  it('Back to Workboard clears the selection', async () => {
    store.selectedItemId.set('instance:a');
    store.selectedWorkboardItem.set(item({ id: 'instance:a', instanceId: 'inst-1' }));
    const fixture = await render();
    const back = fixture.nativeElement.querySelector('.wb-back') as HTMLButtonElement;
    expect(back).toBeTruthy();
    back.click();
    expect(store.clearSelection).toHaveBeenCalled();
  });

  it('closes the detail view gracefully when the selected item disappears', async () => {
    store.selectedItemId.set('instance:a');
    store.selectedWorkboardItem.set(item({ id: 'instance:a', instanceId: 'inst-1' }));
    const fixture = await render();
    expect(fixture.nativeElement.querySelector('app-instance-detail')).toBeTruthy();

    store.selectedWorkboardItem.set(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-instance-detail')).toBeNull();
    expect(fixture.nativeElement.querySelector('.wb-detail-placeholder')).toBeTruthy();
  });
});

describe('workboardSpecialistTarget', () => {
  it('routes each source kind to its specialist surface', async () => {
    expect(workboardSpecialistTarget('repo-job').route).toBe('/tasks');
    expect(workboardSpecialistTarget('automation-run').route).toBe('/automations');
    expect(workboardSpecialistTarget('loop-run').route).toBe('/');
    expect(workboardSpecialistTarget('instance').route).toBe('/');
  });
});
