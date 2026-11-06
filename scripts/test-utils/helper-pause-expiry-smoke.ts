import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { expect, vi } from 'vitest';
import { ipcMain } from 'electron';
import type { LocalAiGuardSnapshot } from '../../src/shared/types/local-ai-guard.types';
import { IPC_CHANNELS } from '../../src/shared/types/ipc.types';
import { AuxiliarySlotBackoff } from '../../src/main/rlm/auxiliary-slot-backoff';
import { getLocalAiAuxiliaryHooks, installLocalAiAuxiliaryRuntimeHooks } from '../../src/main/local-ai-guard/local-ai-auxiliary-bridge';
import { LocalAiGuardRuntime } from '../../src/main/local-ai-guard/local-ai-runtime';
import { registerLocalAiGuardHandlers } from '../../src/main/ipc/handlers/local-ai-guard-handlers';
import { LocalAiGuardStore } from '../../src/renderer/app/core/state/local-ai-guard.store';
import { LocalAiGuardIpcService } from '../../src/renderer/app/core/services/ipc/local-ai-guard-ipc.service';
import { LocalAiStatusChipComponent } from '../../src/renderer/app/features/local-ai-guard/local-ai-status-chip.component';

export async function runHelperPauseExpirySmoke(): Promise<void> {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
  const handle = vi.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => { handlers.set(channel, handler as never); });
  vi.useFakeTimers(); vi.setSystemTime(1000); TestBed.resetTestingModule();
  const guard = new LocalAiGuardRuntime({
    targets: { list: () => [], findByEndpoint: () => undefined },
    health: { listIncidents: () => [], listRecoveryAttempts: () => [] },
    scheduler: { targetChanged: vi.fn(), stop: vi.fn() },
    incidents: { dispose: vi.fn() }, approvals: { listPending: () => [], dispose: vi.fn() },
    engine: { aggregate: () => ({ state: 'not-configured', enrolled: 0, healthy: 0, degraded: 0, unavailable: 0, paused: 0 }) },
    routing: {}, activity: {}, probes: {}, recovery: {},
  } as never);
  const uninstall = installLocalAiAuxiliaryRuntimeHooks(guard);
  let delta: ((snapshot: LocalAiGuardSnapshot) => void) | undefined;
  const cleanup = registerLocalAiGuardHandlers({ getRuntime: () => guard, ensureTrustedSender: () => null,
    windowManager: { sendToRenderer: (channel, value) => { if (channel === IPC_CHANNELS.LOCAL_AI_GUARD_STATUS_DELTA) delta?.(value as LocalAiGuardSnapshot); } } });
  TestBed.configureTestingModule({ imports: [LocalAiStatusChipComponent], providers: [LocalAiGuardStore,
    { provide: Router, useValue: { navigateByUrl: vi.fn() } },
    { provide: LocalAiGuardIpcService, useValue: {
      getSnapshot: () => handlers.get(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)!({}, undefined),
      onStatusDelta: (listener: typeof delta) => { delta = listener; return () => { delta = undefined; }; },
    } },
  ] });
  const store = TestBed.inject(LocalAiGuardStore);
  const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
  try {
    await store.initialize();
    const backoff = new AuxiliarySlotBackoff(Date.now, (pauses, transition) => getLocalAiAuxiliaryHooks().helperBackoffChanged?.(pauses, transition));
    backoff.recordFailure('compression'); backoff.recordFailure('compression');
    await Promise.resolve(); fixture.detectChanges();
    // While the pause is real the chip is on screen. Its name is the visible text;
    // the paused helper type and the reason sit in the description a screen
    // reader reads with it (the chip used to carry them in an aria-label).
    const chip = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(chip.textContent).toContain('helpers paused until');
    const describedBy = chip.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = fixture.nativeElement.querySelector(`#${describedBy}`) as HTMLElement;
    expect(description.textContent).toContain('compression');
    const before = store.snapshot()!.revision;
    await vi.advanceTimersByTimeAsync(60000); fixture.detectChanges();
    expect(backoff.active('compression')).toBeUndefined();
    expect(store.helperPauses()).toEqual([]);
    expect(store.snapshot()!.revision).not.toBe(before);
    // When the pause actually expires the chip is gone, not relabelled "Healthy":
    // healthy and not-set-up show nothing at all, and nothing is left for a
    // screen reader to find either.
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    expect(fixture.nativeElement.querySelector(`#${describedBy}`)).toBeNull();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  } finally {
    store.destroy(); fixture.destroy(); cleanup(); uninstall(); guard.dispose();
    vi.useRealTimers(); TestBed.resetTestingModule(); handle.mockRestore();
  }
}
