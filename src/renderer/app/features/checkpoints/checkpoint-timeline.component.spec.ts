/**
 * Unit tests for CheckpointTimelineComponent non-visual logic.
 *
 * Uses ɵresolveComponentResources (the same approach used by
 * browser-approval-request.component.spec.ts) to handle the external
 * templateUrl/styleUrl before TestBed compiles the component.
 *
 * The Angular compiler plugin is absent from the vitest config so
 * signal-input wiring via TestBed.setInput() is unreliable; we override
 * the signal input getter directly on the instance.
 */

import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CheckpointTimelineComponent,
  type CheckpointEntry,
} from './checkpoint-timeline.component';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

// Resolve external templateUrl/styleUrl to empty strings so Angular JIT
// doesn't attempt HTTP fetches and TestBed can compile without errors.
await resolveComponentResources((url) => {
  if (
    url.endsWith('checkpoint-timeline.component.html') ||
    url.endsWith('checkpoint-timeline.component.scss')
  ) {
    return Promise.resolve('');
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

// ---- Shared helpers ----

function makeCheckpoint(overrides: Partial<CheckpointEntry> = {}): CheckpointEntry {
  return {
    id: 'cp-001',
    instanceId: 'inst-abc',
    timestamp: 1_700_000_000_000,
    name: 'Before refactor',
    description: 'Saved before big change',
    metadata: {
      messageCount: 12,
      tokensUsed: 8000,
      trigger: 'manual',
    },
    ...overrides,
  };
}

interface HistoryIpcStub {
  listSessionSnapshots: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
}

function makeIpcStub(overrides: Partial<HistoryIpcStub> = {}): HistoryIpcStub {
  return {
    listSessionSnapshots: vi.fn().mockResolvedValue({ success: true, data: [] }),
    resumeSession: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

/**
 * Override the readonly signal-input getter directly on the instance.
 * Same workaround used by child-instances-panel.spec and
 * session-progress-panel.spec: vitest lacks the Angular compiler plugin
 * so setInput() wiring is unreliable.
 */
function overrideInstanceId(
  component: CheckpointTimelineComponent,
  id: string,
): void {
  (component as unknown as { instanceId: () => string }).instanceId = () => id;
}

async function createComponent(
  ipcStub: HistoryIpcStub,
): Promise<{
  fixture: ComponentFixture<CheckpointTimelineComponent>;
  component: CheckpointTimelineComponent;
}> {
  await TestBed.configureTestingModule({
    imports: [CheckpointTimelineComponent],
    providers: [{ provide: HistoryIpcService, useValue: ipcStub }],
  }).compileComponents();

  const fixture = TestBed.createComponent(CheckpointTimelineComponent);
  const component = fixture.componentInstance;
  overrideInstanceId(component, 'inst-abc');
  return { fixture, component };
}

// ---- Test suites ----

describe('CheckpointTimelineComponent — load()', () => {
  let component: CheckpointTimelineComponent;
  let ipcStub: HistoryIpcStub;

  beforeEach(async () => {
    ipcStub = makeIpcStub();
    ({ component } = await createComponent(ipcStub));
  });

  it('sets checkpoints sorted newest-first after a successful list call', async () => {
    const entries = [
      makeCheckpoint({ id: 'cp-1', timestamp: 1_000_000_000_000 }),
      makeCheckpoint({ id: 'cp-2', timestamp: 2_000_000_000_000 }),
    ];
    ipcStub.listSessionSnapshots.mockResolvedValue({ success: true, data: entries });

    await component.load();

    expect(component.checkpoints()).toHaveLength(2);
    expect(component.checkpoints()[0].id).toBe('cp-2');
    expect(component.checkpoints()[1].id).toBe('cp-1');
    expect(component.loading()).toBe(false);
    expect(component.error()).toBeNull();
  });

  it('sets error signal on IPC failure', async () => {
    ipcStub.listSessionSnapshots.mockResolvedValue({
      success: false,
      error: { message: 'Session not found' },
    } as IpcResponse);

    await component.load();

    expect(component.checkpoints()).toHaveLength(0);
    expect(component.error()).toBe('Session not found');
    expect(component.loading()).toBe(false);
  });

  it('sets error signal when listSessionSnapshots throws', async () => {
    ipcStub.listSessionSnapshots.mockRejectedValue(new Error('Network error'));

    await component.load();

    expect(component.error()).toBe('Network error');
    expect(component.loading()).toBe(false);
  });

  it('clears previous checkpoints then repopulates when re-loading', async () => {
    ipcStub.listSessionSnapshots
      .mockResolvedValueOnce({
        success: true,
        data: [makeCheckpoint({ id: 'cp-old' })],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [makeCheckpoint({ id: 'cp-new' })],
      });

    await component.load();
    expect(component.checkpoints()[0].id).toBe('cp-old');

    await component.load();
    expect(component.checkpoints()).toHaveLength(1);
    expect(component.checkpoints()[0].id).toBe('cp-new');
  });

  it('is a no-op when instanceId is empty', async () => {
    overrideInstanceId(component, '');

    await component.load();

    expect(ipcStub.listSessionSnapshots).not.toHaveBeenCalled();
    expect(component.loading()).toBe(false);
  });
});

describe('CheckpointTimelineComponent — restore flow', () => {
  let component: CheckpointTimelineComponent;
  let ipcStub: HistoryIpcStub;

  beforeEach(async () => {
    ipcStub = makeIpcStub();
    ({ component } = await createComponent(ipcStub));
  });

  it('requestRestore sets pendingRestoreId', () => {
    component.requestRestore('cp-007');
    expect(component.pendingRestoreId()).toBe('cp-007');
  });

  it('cancelRestore clears pendingRestoreId', () => {
    component.requestRestore('cp-007');
    component.cancelRestore();
    expect(component.pendingRestoreId()).toBeNull();
  });

  it('confirmRestore calls resumeSession and emits restored on success', async () => {
    const cp = makeCheckpoint({ id: 'cp-007' });
    ipcStub.listSessionSnapshots.mockResolvedValue({ success: true, data: [cp] });
    ipcStub.resumeSession.mockResolvedValue({ success: true });

    await component.load();
    component.requestRestore('cp-007');

    const emitted: string[] = [];
    component.restored.subscribe((id) => emitted.push(id));

    await component.confirmRestore();

    expect(ipcStub.resumeSession).toHaveBeenCalledWith('inst-abc', {
      fromSnapshot: 'cp-007',
      restoreMessages: true,
      restoreContext: true,
      restoreTasks: true,
    });
    expect(emitted).toEqual(['cp-007']);
    expect(component.pendingRestoreId()).toBeNull();
    // load() is called again after a successful restore
    expect(ipcStub.listSessionSnapshots).toHaveBeenCalledTimes(2);
    expect(component.error()).toBeNull();
  });

  it('confirmRestore sets error signal when resumeSession fails', async () => {
    const cp = makeCheckpoint({ id: 'cp-007' });
    ipcStub.listSessionSnapshots.mockResolvedValue({ success: true, data: [cp] });
    ipcStub.resumeSession.mockResolvedValue({
      success: false,
      error: { message: 'Restore conflict' },
    } as IpcResponse);

    await component.load();
    component.requestRestore('cp-007');

    const emitted: string[] = [];
    component.restored.subscribe((id) => emitted.push(id));

    await component.confirmRestore();

    expect(emitted).toHaveLength(0);
    expect(component.error()).toBe('Restore conflict');
    expect(component.restoring()).toBe(false);
  });

  it('confirmRestore is a no-op when no pending restore', async () => {
    await component.confirmRestore();
    expect(ipcStub.resumeSession).not.toHaveBeenCalled();
  });
});

describe('CheckpointTimelineComponent — computed signals', () => {
  let component: CheckpointTimelineComponent;
  let ipcStub: HistoryIpcStub;

  beforeEach(async () => {
    ipcStub = makeIpcStub();
    ({ component } = await createComponent(ipcStub));
  });

  it('isEmpty is true when loading is done, checkpoints empty, and no error', () => {
    expect(component.isEmpty()).toBe(true);
  });

  it('isEmpty is false when checkpoints are present', async () => {
    ipcStub.listSessionSnapshots.mockResolvedValue({
      success: true,
      data: [makeCheckpoint()],
    });
    await component.load();
    expect(component.isEmpty()).toBe(false);
  });

  it('pendingCheckpoint resolves the correct entry', async () => {
    const cp = makeCheckpoint({ id: 'cp-007', name: 'Test point' });
    ipcStub.listSessionSnapshots.mockResolvedValue({ success: true, data: [cp] });

    await component.load();
    component.requestRestore('cp-007');

    expect(component.pendingCheckpoint()?.name).toBe('Test point');
  });

  it('pendingCheckpoint is null when no pendingRestoreId', () => {
    expect(component.pendingCheckpoint()).toBeNull();
  });
});

describe('CheckpointTimelineComponent — display helpers', () => {
  let component: CheckpointTimelineComponent;

  beforeEach(async () => {
    ({ component } = await createComponent(makeIpcStub()));
  });

  it('entryLabel returns name when present', () => {
    const cp = makeCheckpoint({ name: 'My checkpoint', description: 'desc' });
    expect(component.entryLabel(cp)).toBe('My checkpoint');
  });

  it('entryLabel falls back to description when name is absent', () => {
    const cp = makeCheckpoint({ name: undefined, description: 'Some description' });
    expect(component.entryLabel(cp)).toBe('Some description');
  });

  it('entryLabel falls back to id suffix when name and description are absent', () => {
    const cp = makeCheckpoint({ id: 'abc-123456', name: undefined, description: undefined });
    expect(component.entryLabel(cp)).toBe('Checkpoint 123456');
  });

  it('triggerLabel maps known values', () => {
    expect(component.triggerLabel('auto')).toBe('Auto');
    expect(component.triggerLabel('manual')).toBe('Manual');
    expect(component.triggerLabel('checkpoint')).toBe('Checkpoint');
  });

  it('triggerLabel returns unknown value unchanged', () => {
    expect(component.triggerLabel('custom-type')).toBe('custom-type');
  });

  it('formatDate returns a non-empty string for a valid timestamp', () => {
    const result = component.formatDate(1_700_000_000_000);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
