import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstanceEventsService } from '../instance-events.service';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

function makeEnv(partial: Partial<ProviderRuntimeEventEnvelope> = {}): ProviderRuntimeEventEnvelope {
  return {
    eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
    seq: 0, timestamp: Date.now(), provider: 'claude', instanceId: 'i-1',
    event: { kind: 'status', status: 'busy' },
    ...partial,
  };
}

describe('InstanceEventsService', () => {
  let captured: ((e: ProviderRuntimeEventEnvelope) => void) | undefined;
  const hadElectronAPI = 'electronAPI' in (window as unknown as Record<string, unknown>);
  const originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;

  beforeEach(() => {
    captured = undefined;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      onProviderRuntimeEvent: (cb: (e: ProviderRuntimeEventEnvelope) => void) => {
        captured = cb;
        return () => { captured = undefined; };
      },
    };
    TestBed.configureTestingModule({ providers: [InstanceEventsService] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    if (hadElectronAPI) {
      (window as unknown as { electronAPI: unknown }).electronAPI = originalElectronAPI;
    } else {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('exposes events$ that emits envelopes from preload', () => {
    const svc = TestBed.inject(InstanceEventsService);
    const received: ProviderRuntimeEventEnvelope[] = [];
    svc.events$.subscribe(e => received.push(e));
    captured!(makeEnv());
    expect(received).toHaveLength(1);
  });

  it('filters by kind via outputEvents$ / statusEvents$', () => {
    const svc = TestBed.inject(InstanceEventsService);
    const statuses: ProviderRuntimeEventEnvelope[] = [];
    const outputs: ProviderRuntimeEventEnvelope[] = [];
    svc.statusEvents$.subscribe(e => statuses.push(e));
    svc.outputEvents$.subscribe(e => outputs.push(e));
    captured!(makeEnv({ event: { kind: 'status', status: 'idle' } }));
    captured!(makeEnv({ seq: 1, event: { kind: 'output', content: 'hi' } }));
    expect(statuses).toHaveLength(1);
    expect(outputs).toHaveLength(1);
  });

  it('warns on seq gap per instanceId', () => {
    const svc = TestBed.inject(InstanceEventsService);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    svc.events$.subscribe(() => undefined);
    captured!(makeEnv({ seq: 0 }));
    captured!(makeEnv({ seq: 2 })); // gap: expected 1
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gap/i));
    warn.mockRestore();
  });
});
