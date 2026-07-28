import {
  ChangeDetectorRef,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiDiagnosticReport,
  LocalAiGuardSnapshot,
  LocalAiRepairResult,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiGuardPageComponent } from './local-ai-guard-page.component';
import { LOCAL_AI_GUARD_CLOCK } from './local-ai-guard-clock';

const NOW = 10_000;
const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  const resource = url.split('/').at(-1);
  if (
    resource === 'local-ai-guard-page.component.html'
    || resource === 'local-ai-guard-page.component.scss'
    || resource === 'local-ai-effectiveness-panel.component.html'
    || resource === 'local-ai-effectiveness-panel.component.scss'
    || resource === 'local-ai-target-setup.component.html'
    || resource === 'local-ai-target-setup.component.scss'
  ) {
    return Promise.resolve(readFileSync(resolve(specDirectory, resource), 'utf8'));
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function status(
  state: LocalAiTargetStatus['state'] = 'degraded',
): LocalAiTargetStatus {
  return {
    targetId: 'target-1',
    lifecycle: 'enrolled',
    state,
    routableRoles: ['compression'],
    layers: {
      worker: {
        targetId: 'target-1',
        layer: 'worker',
        checkType: 'lightweight',
        ok: true,
        required: true,
        affectedRoles: ['compression'],
        checkedAt: NOW - 4_000,
        durationMs: 12,
        evidence: { workerConnected: true },
      },
      endpoint: {
        targetId: 'target-1',
        layer: 'endpoint',
        checkType: 'lightweight',
        ok: true,
        required: true,
        affectedRoles: ['compression'],
        checkedAt: NOW - 3_000,
        durationMs: 18,
        evidence: { endpointVersion: '0.9.4' },
      },
      model: {
        targetId: 'target-1',
        layer: 'model',
        checkType: 'lightweight',
        ok: false,
        required: true,
        affectedRoles: ['compression'],
        checkedAt: NOW - 2_000,
        durationMs: 8,
        failureCode: 'configuration-drift',
        evidence: {
          advertisedModels: ['qwen3:8b'],
          missingModels: ['qwen3:14b'],
        },
      },
      inference: {
        targetId: 'target-1',
        layer: 'inference',
        checkType: 'functional',
        ok: true,
        required: true,
        affectedRoles: ['compression'],
        checkedAt: NOW - 1_000,
        durationMs: 220,
        evidence: { canaryOutputValid: true },
      },
    },
    consecutiveFailures: 2,
    consecutiveSuccesses: 0,
    flapping: false,
    checkedAt: NOW - 1_000,
  };
}

function discovery(): LocalAiDiscoveredEndpoint {
  return {
    identity: {
      location: { type: 'worker', nodeId: 'worker-1' },
      provider: 'ollama',
      endpointId: 'ollama',
      baseUrl: 'http://192.168.1.20:11434',
    },
    label: 'Studio worker · Ollama',
    models: ['qwen3:8b'],
    healthy: true,
    enrolledTargetId: 'target-1',
  };
}

function configuredTarget(): LocalAiTarget {
  return {
    ...discovery().identity,
    id: 'target-1',
    label: 'Studio worker',
    lifecycle: 'enrolled',
    expectedModels: [{ modelId: 'qwen3:8b', required: true }],
    canary: { model: 'qwen3:8b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: true, maxAttempts: 2, cooldownMs: 60_000 },
    createdAt: 1,
    updatedAt: 2,
  };
}

function snapshot(targets: LocalAiTargetStatus[] = [status()]): LocalAiGuardSnapshot {
  return {
    revision: '4',
    aggregate: {
      state: targets.length ? 'degraded' : 'not-configured',
      enrolled: targets.length,
      healthy: 0,
      degraded: targets.length,
      unavailable: 0,
      paused: 0,
    },
    targets,
    targetConfigs: [],
    incidents: [{
      id: 'incident-1',
      targetId: 'target-1',
      state: 'open',
      severity: 'warning',
      failureCode: 'configuration-drift',
      affectedLayers: ['model'],
      affectedRoles: ['compression'],
      openedAt: NOW - 5_000,
      updatedAt: NOW - 2_000,
      fallbackCount: 2,
      knownCostUsd: 0.04,
      estimatedCostUsd: 0.02,
    }],
    recoveryAttempts: [],
    pendingFallbacks: [],
  };
}

describe('LocalAiGuardPageComponent', () => {
  let clockNow = NOW;
  const store = {
    initialize: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    loadInventory: vi.fn(async () => undefined),
    snapshot: vi.fn(() => snapshot()),
    hasAuthoritativeSnapshot: vi.fn(() => true),
    aggregate: vi.fn(() => snapshot().aggregate),
    targets: vi.fn(() => [status()]),
    activeIncidents: vi.fn(() => snapshot().incidents),
    discoveries: vi.fn(() => [discovery()]),
    error: vi.fn((): string | null => null),
    operationError: vi.fn((): string | null => null),
    operationKey: vi.fn(() => null),
    recheckTarget: vi.fn(async () => undefined),
    setTargetLifecycle: vi.fn<LocalAiGuardStore['setTargetLifecycle']>(
      async () => configuredTarget(),
    ),
    acknowledgeIncident: vi.fn(async () => undefined),
    diagnoseTarget: vi.fn(async () => undefined),
    repairTarget: vi.fn(async () => undefined),
    diagnosticFor: vi.fn<(targetId: string) => LocalAiDiagnosticReport | null>(() => null),
    repairFor: vi.fn<(targetId: string) => LocalAiRepairResult | null>(() => null),
    recoveryAttempts: vi.fn(() => []),
    knownTarget: vi.fn<(targetId: string) => LocalAiTarget | null>(() => null),
    effectiveness: vi.fn(() => null),
    effectivenessWindow: vi.fn(() => '24h' as const),
    effectivenessLoading: vi.fn(() => false),
    effectivenessError: vi.fn(() => null),
    loadEffectiveness: vi.fn(async () => undefined),
  };
  let fixture: ComponentFixture<LocalAiGuardPageComponent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    clockNow = NOW;
    vi.clearAllMocks();
    store.discoveries.mockReturnValue([discovery()]);
    store.knownTarget.mockReturnValue(configuredTarget());
    await TestBed.configureTestingModule({
      imports: [LocalAiGuardPageComponent],
      providers: [
        { provide: LocalAiGuardStore, useValue: store },
        { provide: LOCAL_AI_GUARD_CLOCK, useValue: () => clockNow },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LocalAiGuardPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('loads inventory and renders worker → endpoint → model → canary evidence', () => {
    expect(store.initialize).toHaveBeenCalledOnce();
    expect(store.loadInventory).toHaveBeenCalledOnce();

    const card = fixture.nativeElement.querySelector('[data-target-id="target-1"]') as HTMLElement;
    expect(card.textContent).toContain('Studio worker');
    expect(card.textContent).not.toContain('Studio worker · Ollama');
    expect(card.textContent).toContain('Worker endpoint');
    expect(card.textContent).toContain('Currently advertised');
    expect(card.textContent).toContain('Worker');
    expect(card.textContent).toContain('Endpoint');
    expect(card.textContent).toContain('Model');
    expect(card.textContent).toContain('Canary');
    expect(card.textContent).toContain('qwen3:14b');
    expect(card.textContent).toContain('Configuration drift');
    expect(card.textContent).toContain('Compression');
    expect(card.textContent).toContain('Last success');
    expect(card.textContent).toContain('Last failure');
    expect(card.textContent).toContain('2 paid fallbacks');
  });

  it('mounts the historical effectiveness dashboard without changing live evidence', () => {
    const targetBefore = store.targets();
    const incidentBefore = store.activeIncidents();

    expect(fixture.nativeElement.querySelector('app-local-ai-effectiveness-panel')).not.toBeNull();
    expect(store.loadEffectiveness).toHaveBeenCalledWith('24h');
    expect(store.targets()).toEqual(targetBefore);
    expect(store.activeIncidents()).toEqual(incidentBefore);
  });

  it('retains authoritative worker identity when the endpoint is not currently advertised', async () => {
    store.discoveries.mockReturnValue([]);
    store.knownTarget.mockReturnValue(configuredTarget());
    await recreateFixture();

    const card = fixture.nativeElement.querySelector('[data-target-id="target-1"]') as HTMLElement;
    expect(card.textContent).toContain('Studio worker');
    expect(card.textContent).toContain('Worker endpoint');
    expect(card.textContent).toContain('Not currently advertised');
    expect(card.textContent).not.toContain('Coordinator endpoint');
  });

  it('retains authoritative coordinator identity without current discovery', async () => {
    store.discoveries.mockReturnValue([]);
    store.knownTarget.mockReturnValue({
      ...configuredTarget(),
      label: 'Coordinator Ollama',
      location: { type: 'coordinator' },
      baseUrl: 'http://127.0.0.1:11434',
    });
    await recreateFixture();

    const card = fixture.nativeElement.querySelector('[data-target-id="target-1"]') as HTMLElement;
    expect(card.textContent).toContain('Coordinator Ollama');
    expect(card.textContent).toContain('Coordinator endpoint');
    expect(card.textContent).toContain('Not currently advertised');
    expect(card.textContent).not.toContain('Worker endpoint');
  });

  it('labels a legacy unsupported guided result as unsupported', () => {
    store.repairFor.mockReturnValue({
      targetId: 'target-1',
      action: 'restart-ollama',
      outcome: 'guided',
      supported: false,
      attempted: false,
      recovered: false,
      message: 'This target is not an Ollama endpoint.',
      completedAt: NOW,
    });
    fixture.debugElement
      .query(By.css('[data-target-id="target-1"]'))
      .injector.get(ChangeDetectorRef)
      .markForCheck();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Restart Ollama unsupported');
    expect(fixture.nativeElement.textContent).not.toContain('Restart Ollama guidance shown');
  });

  it('refreshes relative ages from the injected clock and owns ticker cleanup', async () => {
    expect(fixture.nativeElement.textContent).toContain('Evidence 1s ago');
    clockNow += 61_000;
    await vi.advanceTimersByTimeAsync(1_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Evidence 1m ago');

    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs a real manual check and lifecycle mutations with guarded retirement', async () => {
    click('Run check');
    await fixture.whenStable();
    expect(store.recheckTarget).toHaveBeenCalledWith('target-1', 'lightweight');

    click('Pause');
    await fixture.whenStable();
    expect(store.setTargetLifecycle).toHaveBeenCalledWith('target-1', 'paused');

    clockNow += 30 * 60_000;
    click('Pause for 1 hour');
    await fixture.whenStable();
    expect(store.setTargetLifecycle).toHaveBeenCalledWith(
      'target-1',
      'paused',
      { pausedUntil: clockNow + 3_600_000 },
    );

    click('Retire');
    fixture.detectChanges();
    expect(store.setTargetLifecycle).not.toHaveBeenCalledWith('target-1', 'retired');
    const dialog = fixture.nativeElement.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Retire Studio worker?');

    click('Confirm retirement');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.setTargetLifecycle).toHaveBeenCalledWith('target-1', 'retired');
    expect(document.activeElement?.textContent?.trim()).toBe('Run check');
  });

  it('keeps a failed retirement dialog open with a target-scoped accessible name', async () => {
    store.setTargetLifecycle.mockResolvedValueOnce(undefined);
    click('Retire');
    fixture.detectChanges();
    let dialog = fixture.nativeElement.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-labelledby')).toBe('retire-target-title-target-1');

    click('Confirm retirement');
    await fixture.whenStable();
    fixture.detectChanges();
    dialog = fixture.nativeElement.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('could not be retired');
  });

  it('traps forward tab navigation inside the retirement dialog', () => {
    click('Retire');
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[role="alertdialog"]') as HTMLElement;
    const buttons = Array.from(
      dialog.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    buttons.at(-1)?.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('allows only one confirmation modal across target and incident actions', () => {
    store.diagnosticFor.mockReturnValue({
      targetId: 'target-1',
      checkedAt: NOW,
      samples: [],
      recommendedActions: ['restart-ollama'],
    });
    store.knownTarget.mockReturnValue(configuredTarget());
    fixture.detectChanges();
    click('Retire');
    click('Restart Ollama automatically');
    fixture.detectChanges();

    const dialogs = fixture.nativeElement.querySelectorAll('[role="alertdialog"]');
    expect(dialogs).toHaveLength(1);
    expect((dialogs[0] as HTMLElement).textContent).toContain('Restart Ollama automatically?');
  });

  it('shows loading, unavailable, empty, error, and recovery states without raw details', async () => {
    store.hasAuthoritativeSnapshot.mockReturnValue(false);
    store.error.mockReturnValue('private://token=secret');
    fixture.destroy();
    fixture = TestBed.createComponent(LocalAiGuardPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Health status unavailable');
    expect(fixture.nativeElement.textContent).not.toContain('token=secret');
    click('Try again');
    await fixture.whenStable();
    expect(store.refresh).toHaveBeenCalled();

    store.hasAuthoritativeSnapshot.mockReturnValue(true);
    store.targets.mockReturnValue([]);
    store.activeIncidents.mockReturnValue([]);
    store.aggregate.mockReturnValue(snapshot([]).aggregate);
    fixture.destroy();
    fixture = TestBed.createComponent(LocalAiGuardPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No enrolled targets');
    expect(fixture.nativeElement.textContent).toContain('Discovered endpoints remain unmanaged');
  });

  function click(label: string): void {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    const button = buttons.find((candidate) => candidate.textContent?.trim() === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    button.click();
    fixture.detectChanges();
  }

  async function recreateFixture(): Promise<void> {
    fixture.destroy();
    fixture = TestBed.createComponent(LocalAiGuardPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
});
