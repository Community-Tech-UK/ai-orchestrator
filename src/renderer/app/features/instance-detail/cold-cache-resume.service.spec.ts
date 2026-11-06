import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { COLD_CACHE_IDLE_MS } from './cold-cache-resume';
import { ColdCacheChipComponent } from './cold-cache-chip.component';

const NOW = 1_700_000_000_000;

describe('ColdCacheResumeService', () => {
  let instance: { provider: string; status: string; contextUsage: { used: number; occupancyReported: boolean }; outputBuffer: { type: string; timestamp: number }[] };
  let enabled: boolean;
  const compactInstance = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    compactInstance.mockReset().mockResolvedValue(true);
    enabled = true;
    instance = { provider: 'claude', status: 'idle', contextUsage: { used: 150_000, occupancyReported: true },
      outputBuffer: [{ type: 'assistant', timestamp: NOW - COLD_CACHE_IDLE_MS }] };
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: { getInstance: () => instance, isInstanceCompacting: () => false, compactInstance } },
      { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: () => 0 } },
      { provide: SettingsStore, useValue: { settings: () => ({ coldCacheCompactFirst: enabled }) } },
    ] });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('holds the send until real compaction success', async () => {
    const service = TestBed.inject(ColdCacheResumeService);
    const send = vi.fn(); const restore = vi.fn();
    await service.compactThenSend('one', 'message', send, restore);
    expect(compactInstance).toHaveBeenCalledWith('one');
    expect(send).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
  });

  it('restores the message after a failed compaction and sends nothing', async () => {
    compactInstance.mockResolvedValue(false);
    const service = TestBed.inject(ColdCacheResumeService);
    const send = vi.fn(); const restore = vi.fn();
    await service.compactThenSend('one', 'message', send, restore);
    expect(send).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith('message');
    expect(service.phaseFor('one')).toBe('failed');
  });

  it('sends full history once, then selects compact first again', async () => {
    const service = TestBed.inject(ColdCacheResumeService);
    service.setPreferCompact('one', false);
    const send = vi.fn();
    await service.compactThenSend('one', 'message', send, vi.fn());
    expect(compactInstance).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(service.shouldCompactFirst('one')).toBe(true);
  });

  it('cancel restores the text and clears the compacting state at once, then sends nothing when the compaction later succeeds', async () => {
    let finish: (value: boolean) => void = () => undefined;
    compactInstance.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const service = TestBed.inject(ColdCacheResumeService);
    const send = vi.fn(); const restore = vi.fn();
    const pending = service.compactThenSend('one', 'message', send, restore);
    expect(service.phaseFor('one')).toBe('compacting');
    service.cancelPendingSend('one');
    // Before the compaction returns: the box already has the text and the chip has left "compacting".
    expect(restore).toHaveBeenCalledExactlyOnceWith('message');
    expect(service.phaseFor('one')).toBe('idle');
    expect(send).not.toHaveBeenCalled();
    finish(true);
    await pending;
    expect(send).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(service.phaseFor('one')).toBe('idle');
  });

  it('a cancelled compaction that later fails neither restores again nor shows the failure notice', async () => {
    let finish: (value: boolean) => void = () => undefined;
    compactInstance.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const service = TestBed.inject(ColdCacheResumeService);
    const send = vi.fn(); const restore = vi.fn();
    const pending = service.compactThenSend('one', 'message', send, restore);
    service.cancelPendingSend('one');
    finish(false);
    await pending;
    expect(send).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(service.phaseFor('one')).toBe('idle');
  });

  it('a late result from a cancelled run does not disturb a newer run for the same instance', async () => {
    const finishers: ((value: boolean) => void)[] = [];
    compactInstance.mockImplementation(() => new Promise<boolean>(resolve => { finishers.push(resolve); }));
    const service = TestBed.inject(ColdCacheResumeService);
    const sendOne = vi.fn(); const restoreOne = vi.fn();
    const sendTwo = vi.fn(); const restoreTwo = vi.fn();
    const first = service.compactThenSend('one', 'first', sendOne, restoreOne);
    service.cancelPendingSend('one');
    const second = service.compactThenSend('one', 'second', sendTwo, restoreTwo);
    expect(service.phaseFor('one')).toBe('compacting');
    finishers[0](true);
    await first;
    // The stale result must not send, restore, or flip the newer run out of "compacting".
    expect(sendOne).not.toHaveBeenCalled();
    expect(restoreOne).toHaveBeenCalledTimes(1);
    expect(sendTwo).not.toHaveBeenCalled();
    expect(service.phaseFor('one')).toBe('compacting');
    finishers[1](true);
    await second;
    expect(sendTwo).toHaveBeenCalledOnce();
    expect(restoreTwo).not.toHaveBeenCalled();
    expect(service.phaseFor('one')).toBe('idle');
  });

  it('cancel with nothing in flight does nothing', () => {
    const service = TestBed.inject(ColdCacheResumeService);
    expect(() => service.cancelPendingSend('one')).not.toThrow();
    expect(service.phaseFor('one')).toBe('idle');
  });

  it('ticks across the idle boundary and respects the setting', () => {
    instance.outputBuffer[0].timestamp = NOW - 69 * 60_000;
    const service = TestBed.inject(ColdCacheResumeService);
    expect(service.offerFor('one').offer).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(service.offerFor('one').offer).toBe(true);
    enabled = false;
    expect(service.offerFor('one').offer).toBe(false);
  });

  it('starts the real chip clock from a computed offer and keeps it reactive', () => {
    // The service can be injected long before the first chip is rendered.
    TestBed.inject(ColdCacheResumeService);
    instance.outputBuffer[0].timestamp = NOW - 69 * 60_000;
    vi.advanceTimersByTime(5 * 60_000);
    const fixture = TestBed.createComponent(ColdCacheChipComponent);
    fixture.componentRef.setInput('instanceId', 'one');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('away 1 h 14 min');
    expect(fixture.nativeElement.textContent).toContain('about 150K tokens');
    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('away 1 h 15 min');
  });
});
