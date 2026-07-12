import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RLM_STORAGE_HARD_LIMIT_BYTES } from '../../../../shared/types/rlm-maintenance.types';
import { RlmStorageMaintenanceStore } from '../../core/state/rlm-storage-maintenance.store';
import { RlmStorageMaintenanceComponent } from './rlm-storage-maintenance.component';

describe('RlmStorageMaintenanceComponent', () => {
  let fixture: ComponentFixture<RlmStorageMaintenanceComponent>;
  let store: ReturnType<typeof fakeStore>;

  beforeEach(async () => {
    store = fakeStore();
    await TestBed.configureTestingModule({
      imports: [RlmStorageMaintenanceComponent],
      providers: [{ provide: RlmStorageMaintenanceStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(RlmStorageMaintenanceComponent);
    // Signal inputs are assigned directly in this JIT suite, matching the
    // existing loop-control tests (ComponentRef.setInput is not reflected by
    // Angular's extracted-resource JIT setup here).
    (fixture.componentInstance as unknown as { loopRunId: () => string }).loopRunId = () => 'loop-1';
    fixture.detectChanges();
  });

  it('shows warning health and opens an exact-candidate preview', () => {
    expect(fixture.nativeElement.textContent).toContain('RLM storage needs maintenance');
    click('Review cleanup');
    expect(store.openPreview).toHaveBeenCalledWith('loop-1');

    store.modalOpen.set(true);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Eligible stores');
    expect(text).toContain('Live protected');
    expect(text).toContain('Codebase protected');
    expect(text).toContain('/backups');
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('makes progress non-dismissible and suppresses repeated execution', () => {
    store.modalOpen.set(true);
    store.busy.set(true);
    store.progress.set({
      operationId: 'op-1',
      stage: 'compacting',
      message: 'Compacting the RLM database',
      startedAt: 1,
      updatedAt: 2,
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Compacting the RLM database');
    expect(fixture.nativeElement.querySelector('button[aria-label="Close"]')).toBeNull();
    expect(button('Maintenance running…').disabled).toBe(true);
  });

  it('focuses the dialog and closes it with Escape when maintenance is idle', async () => {
    store.modalOpen.set(true);
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    const focus = vi.spyOn(dialog, 'focus');
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    expect(focus).toHaveBeenCalledWith();

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.closePreview).toHaveBeenCalledOnce();
    focus.mockRestore();
  });

  it('reports verified success, cleanup warnings, backup, and blocked resume outcome', () => {
    store.health.set({ ...store.health()!, level: 'critical', databaseSizeBytes: RLM_STORAGE_HARD_LIMIT_BYTES });
    store.modalOpen.set(true);
    store.result.set({
      status: 'success',
      operationId: 'op-1',
      storesDeleted: 4,
      databaseSizeBeforeBytes: RLM_STORAGE_HARD_LIMIT_BYTES,
      databaseSizeAfterBytes: RLM_STORAGE_HARD_LIMIT_BYTES,
      externalContentSizeBeforeBytes: 20,
      externalContentSizeAfterBytes: 10,
      verifiedBytesReclaimed: 10,
      backupPath: '/backups/verified.db',
      externalContentCleanupFailures: 2,
      loopResumed: false,
      databaseHealthy: false,
      completedAt: 2,
    });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('RLM storage limit reached');
    expect(text).toContain('Cleanup completed and verified');
    expect(text).toContain('Database: 12.0 GiB before · 12.0 GiB after');
    expect(text).toContain('External content: 20 B before · 10 B after');
    expect(text).toContain('/backups/verified.db');
    expect(text).toContain('2 external content files could not be removed');
    expect(text).toContain('still at or above 12 GiB');
  });

  it('shows staged failure and retries through the guarded store', () => {
    store.modalOpen.set(true);
    store.result.set({
      status: 'failed',
      operationId: 'op-1',
      failedStage: 'backing-up',
      error: 'integrity check failed',
      storesDeleted: 0,
      externalContentCleanupFailures: 0,
      completedAt: 2,
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Cleanup failed during Backing up');
    click('Review retry');
    expect(store.openPreview).toHaveBeenCalledWith('loop-1');
  });

  function button(label: string): HTMLButtonElement {
    const candidates = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const match = candidates.find((candidate) => candidate.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button ${label}`);
    return match;
  }

  function click(label: string): void { button(label).click(); }
});

function fakeStore() {
  const health = signal({
    level: 'warning' as 'healthy' | 'warning' | 'critical',
    databaseSizeBytes: 10 * 1024 ** 3,
    externalContentSizeBytes: 20,
    reclaimableDatabaseBytes: 30,
    warningThresholdBytes: 10 * 1024 ** 3,
    hardLimitBytes: 12 * 1024 ** 3,
    maintenanceRunning: false,
    checkedAt: 1,
  });
  const dismissed = signal(false);
  return {
    health,
    preview: signal({
      databaseSizeBytes: 10 * 1024 ** 3,
      externalContentSizeBytes: 20,
      reclaimableDatabaseBytes: 30,
      eligibleStoreCount: 3,
      protectedLiveStoreCount: 1,
      protectedCodebaseAutoStoreCount: 2,
      cutoffTimestamp: 1,
      retentionDays: 60,
      backupDirectory: '/backups',
      canRun: true,
      generatedAt: 1,
    }),
    progress: signal(null as never),
    result: signal(null as never),
    busy: signal(false),
    modalOpen: signal(false),
    dismissed,
    error: signal<string | null>(null),
    visible: computed(() => health().level !== 'healthy' && (health().level === 'critical' || !dismissed())),
    refreshHealth: vi.fn(async () => undefined),
    restoreStatus: vi.fn(async () => undefined),
    openPreview: vi.fn(async () => undefined),
    closePreview: vi.fn(),
    run: vi.fn(async () => undefined),
    dismiss: vi.fn(() => dismissed.set(true)),
  };
}
