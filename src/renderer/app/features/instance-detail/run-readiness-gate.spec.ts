/**
 * `RunReadinessGate` is the piece `InputPanelComponent.canSend()` reads
 * (`if (this.runReadiness.blocking()) return false;` — input-panel.component.ts).
 * These tests exercise the disable logic directly, since driving the same
 * path through the full `InputPanelComponent` spec would need to fake the
 * async startup-capabilities IPC pull through several more layers.
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { RunReadinessGate } from './run-readiness-banner.component';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import type { StartupCapabilityReport } from '../../../../shared/types/startup-capability.types';

function configure(report: StartupCapabilityReport | null): void {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AppIpcService,
        useValue: { getStartupCapabilities: vi.fn().mockResolvedValue(report) },
      },
    ],
  });
}

describe('RunReadinessGate', () => {
  it('starts with no reasons and not blocking before the startup-capabilities pull resolves', () => {
    configure(null);
    const gate = TestBed.runInInjectionContext(() => new RunReadinessGate(signal('claude')));
    expect(gate.reasons()).toEqual([]);
    expect(gate.blocking()).toBe(false);
  });

  it('becomes blocking once the pull resolves to no provider CLI being available', async () => {
    configure({
      status: 'failed',
      generatedAt: 0,
      checks: [
        { id: 'provider.any', label: 'Provider availability', category: 'provider', status: 'unavailable', critical: true, summary: 'No supported provider CLI is currently available.' },
      ],
    });
    const gate = TestBed.runInInjectionContext(() => new RunReadinessGate(signal('claude')));

    expect(gate.blocking()).toBe(false); // pull is still in flight
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.blocking()).toBe(true);
    expect(gate.reasons()).toEqual([
      {
        id: 'provider-none-available',
        severity: 'blocking',
        message: 'No supported provider CLI is currently available.',
        action: { label: 'Open Doctor', commandId: 'app.open-doctor' },
      },
    ]);
  });

  it('stays non-blocking (warning only) for a degraded — but not totally unavailable — provider', async () => {
    configure({
      status: 'degraded',
      generatedAt: 0,
      checks: [
        { id: 'provider.any', label: 'Provider availability', category: 'provider', status: 'ready', critical: true, summary: 'ok' },
        { id: 'provider.codex', label: 'Codex CLI', category: 'provider', status: 'degraded', critical: false, summary: 'Codex CLI is not available on PATH.' },
      ],
    });
    const gate = TestBed.runInInjectionContext(() => new RunReadinessGate(signal('codex')));
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.blocking()).toBe(false);
    expect(gate.reasons()).toHaveLength(1);
    expect(gate.reasons()[0].severity).toBe('warning');
  });

  it('re-evaluates when the composer\'s provider signal changes', async () => {
    configure({
      status: 'degraded',
      generatedAt: 0,
      checks: [
        { id: 'provider.any', label: 'Provider availability', category: 'provider', status: 'ready', critical: true, summary: 'ok' },
        { id: 'provider.codex', label: 'Codex CLI', category: 'provider', status: 'degraded', critical: false, summary: 'Codex CLI is not available on PATH.' },
      ],
    });
    const provider = signal<'claude' | 'codex'>('claude');
    const gate = TestBed.runInInjectionContext(() => new RunReadinessGate(provider));
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.reasons()).toEqual([]); // claude has no degraded check

    provider.set('codex');
    expect(gate.reasons()).toHaveLength(1);
  });
});
