import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiGuardSnapshot,
  LocalAiIncident,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardIpcService } from '../../core/services/ipc/local-ai-guard-ipc.service';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LOCAL_AI_GUARD_CLOCK } from './local-ai-guard-clock';
import { LocalAiGuardPageComponent } from './local-ai-guard-page.component';

const NOW = 10_000;
const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  const resource = url.split('/').at(-1);
  if (
    resource === 'local-ai-guard-page.component.html'
    || resource === 'local-ai-guard-page.component.scss'
    || resource === 'local-ai-target-setup.component.html'
    || resource === 'local-ai-target-setup.component.scss'
  ) {
    return Promise.resolve(readFileSync(resolve(specDirectory, resource), 'utf8'));
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('Local AI Guard disappearing-card focus integration', () => {
  let delta: ((snapshot: LocalAiGuardSnapshot) => void) | undefined;
  let currentSnapshot: LocalAiGuardSnapshot;
  let fixture: ComponentFixture<LocalAiGuardPageComponent>;
  const ipc = {
    getSnapshot: vi.fn(async () => ({ success: true, data: currentSnapshot })),
    onStatusDelta: vi.fn((listener: (snapshot: LocalAiGuardSnapshot) => void) => {
      delta = listener;
      return vi.fn();
    }),
    discover: vi.fn(async (): Promise<{
      success: true;
      data: LocalAiDiscoveredEndpoint[];
    }> => ({ success: true, data: [] })),
    setTargetLifecycle: vi.fn(),
    diagnose: vi.fn(async () => ({
      success: true,
      data: {
        targetId: 'target-1',
        checkedAt: NOW,
        samples: [],
        recommendedActions: ['restart-ollama'],
      },
    })),
    repair: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    delta = undefined;
    currentSnapshot = snapshot('1', [status()], [target()]);
    await TestBed.configureTestingModule({
      imports: [LocalAiGuardPageComponent],
      providers: [
        LocalAiGuardStore,
        { provide: LocalAiGuardIpcService, useValue: ipc },
        { provide: LOCAL_AI_GUARD_CLOCK, useValue: () => NOW },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LocalAiGuardPageComponent);
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('restores focus to a surviving page action when retirement delta removes the card before await resumes', async () => {
    ipc.setTargetLifecycle.mockImplementationOnce(async () => {
      currentSnapshot = snapshot('2', [], []);
      delta?.(currentSnapshot);
      fixture.detectChanges();
      return { success: true, data: { ...target(), lifecycle: 'retired' as const } };
    });

    click('Retire');
    click('Confirm retirement');
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-target-id="target-1"]')).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent?.trim()).toBe('Enrol target');
    });
  });

  it('restores focus to the target when recovered restart delta removes its incident', async () => {
    currentSnapshot = snapshot('2', [status()], [target()], [incident()]);
    delta?.(currentSnapshot);
    fixture.detectChanges();
    click('Diagnose');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(button('Restart Ollama automatically')).not.toBeNull();
    });
    ipc.repair.mockImplementationOnce(async () => {
      currentSnapshot = snapshot('3', [status()], [target()]);
      delta?.(currentSnapshot);
      fixture.detectChanges();
      return {
        success: true,
        data: {
          targetId: 'target-1',
          action: 'restart-ollama',
          outcome: 'recovered',
          supported: true,
          attempted: true,
          recovered: true,
          message: 'Fixed recovery completed.',
          completedAt: NOW + 1,
        },
      };
    });

    click('Restart Ollama automatically');
    click('Confirm automatic restart');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.incident')).toBeNull();
      expect(document.activeElement?.textContent?.trim()).toBe('Run check');
    });
  });

  it('renders advertisement strictly from discovery disappearance and reappearance', async () => {
    const store = TestBed.inject(LocalAiGuardStore);
    ipc.discover.mockResolvedValueOnce({
      success: true,
      data: [discoveredEndpoint()],
    });
    await store.loadInventory();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Currently advertised');

    ipc.discover.mockResolvedValueOnce({ success: true, data: [] });
    await store.loadInventory();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Not currently advertised');

    ipc.discover.mockResolvedValueOnce({
      success: true,
      data: [discoveredEndpoint()],
    });
    await store.loadInventory();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Currently advertised');
  });

  function click(label: string): void {
    button(label).click();
    fixture.detectChanges();
  }

  function button(label: string): HTMLButtonElement {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    const button = buttons.find((candidate) => candidate.textContent?.trim() === label);
    if (!button) {
      throw new Error(`Missing button: ${label}; page=${fixture.nativeElement.textContent}`);
    }
    return button;
  }
});

function target(): LocalAiTarget {
  return {
    id: 'target-1',
    label: 'Local Ollama',
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
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

function status(): LocalAiTargetStatus {
  return {
    targetId: 'target-1',
    lifecycle: 'enrolled',
    state: 'healthy',
    routableRoles: ['compression'],
    layers: {},
    consecutiveFailures: 0,
    consecutiveSuccesses: 2,
    flapping: false,
    checkedAt: NOW,
  };
}

function snapshot(
  revision: string,
  targets: LocalAiTargetStatus[],
  targetConfigs: LocalAiTarget[],
  incidents: LocalAiIncident[] = [],
): LocalAiGuardSnapshot {
  return {
    revision,
    aggregate: {
      state: targets.length ? 'healthy' : 'not-configured',
      enrolled: targets.length,
      healthy: targets.length,
      degraded: 0,
      unavailable: 0,
      paused: 0,
    },
    targets,
    targetConfigs,
    incidents,
    recoveryAttempts: [],
    pendingFallbacks: [],
    fallbackNotifications: [],
  };
}

function incident(): LocalAiIncident {
  return {
    id: 'incident-1',
    targetId: 'target-1',
    state: 'open',
    severity: 'critical',
    failureCode: 'endpoint-timeout',
    affectedLayers: ['endpoint'],
    affectedRoles: ['compression'],
    openedAt: 1,
    updatedAt: 2,
    fallbackCount: 0,
    knownCostUsd: 0,
    estimatedCostUsd: 0,
    unpricedDispatchCount: 0,
  };
}

function discoveredEndpoint(): LocalAiDiscoveredEndpoint {
  return {
    identity: {
      location: { type: 'coordinator' },
      provider: 'ollama',
      endpointId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    },
    label: 'Local Ollama',
    models: ['qwen3:8b'],
    healthy: true,
  };
}
