import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossModelReviewIpcService } from './cross-model-review-ipc.service';
import { ElectronIpcService } from './electron-ipc.service';
import { CrossModelReviewIndicatorComponent } from '../../../features/instance-detail/cross-model-review-indicator.component';
import { ReviewSettingsTabComponent } from '../../../features/settings/review-settings-tab.component';
import { SettingsStore } from '../../state/settings.store';
import { UnifiedCatalogStore } from '../../../features/models/unified-catalog.store';
import { ProviderIpcService } from './provider-ipc.service';
import type { CrossModelReviewStatus } from '../../../../../shared/types/cross-model-review.types';
import type { IpcResponse } from './electron-ipc.service';

await resolveComponentResources(async url => {
  if (url.endsWith('.scss')) return '';
  throw new Error(`Unexpected resource: ${url}`);
});

type DailyUsage = NonNullable<CrossModelReviewStatus['dailyUsage']>;
const firstMidnight = new Date(2026, 9, 13).getTime();
const secondMidnight = new Date(2026, 9, 14).getTime();
const thirdMidnight = new Date(2026, 9, 15).getTime();

function snapshot(used: number, resetsAt: number): CrossModelReviewStatus {
  return { enabled: true, reviewers: [], pendingReviews: 0,
    dailyUsage: { used, limit: 20, resetsAt, limitReached: used >= 20 } };
}

describe('cross-model daily usage deadline', () => {
  let service: CrossModelReviewIpcService;
  let started: (() => void) | undefined;
  let skipped: ((data: { dailyUsage: DailyUsage }) => void) | undefined;
  let current: CrossModelReviewStatus;
  const statusApi = vi.fn<() => Promise<IpcResponse<CrossModelReviewStatus>>>();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(firstMidnight - 1000);
    started = undefined;
    skipped = undefined;
    current = snapshot(20, firstMidnight);
    statusApi.mockReset().mockImplementation(async () => ({ success: true, data: current }));
    TestBed.configureTestingModule({
      imports: [CrossModelReviewIndicatorComponent, ReviewSettingsTabComponent],
      providers: [CrossModelReviewIpcService,
        { provide: ElectronIpcService, useValue: { getApi: () => ({
          crossModelReviewStatus: statusApi,
          crossModelReviewOnStarted: (callback: (data: { instanceId: string; reviewId: string }) => void) => {
            started = () => callback({ instanceId: 'fixture', reviewId: 'review-fixture' });
          },
          crossModelReviewOnSkipped: (callback: typeof skipped) => { skipped = callback; },
        }) } },
        { provide: SettingsStore, useValue: { reviewSettings: () => [], get: (key: string) => key === 'crossModelReviewProviders' ? [] : undefined } },
        { provide: UnifiedCatalogStore, useValue: { ensureLoaded: () => undefined, displayModelsForProvider: () => [] } },
        { provide: ProviderIpcService, useValue: {} },
      ],
    });
    TestBed.overrideComponent(ReviewSettingsTabComponent, { set: { styles: [], styleUrl: undefined, styleUrls: [] } });
    await TestBed.compileComponents();
    service = TestBed.inject(CrossModelReviewIpcService);
    await service.refreshStatus();
    statusApi.mockClear();
  });

  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('refreshes both already-open real component templates across successive midnights without events', async () => {
    const indicator = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    indicator.componentRef.setInput('instanceId', 'fixture');
    const settings = TestBed.createComponent(ReviewSettingsTabComponent);
    indicator.detectChanges(); settings.detectChanges();
    expect(indicator.nativeElement.textContent).toContain('Limit reached');
    expect(settings.nativeElement.querySelector('p[role="status"]').textContent).toBe('Used today: 20 of 20');

    current = snapshot(0, secondMidnight);
    await vi.advanceTimersByTimeAsync(2000);
    indicator.detectChanges(); settings.detectChanges();
    expect(statusApi).toHaveBeenCalledTimes(1);
    expect(indicator.nativeElement.textContent).not.toContain('Limit reached');
    expect(settings.nativeElement.querySelector('p[role="status"]').textContent).toBe('Used today: 0 of 20');

    current = snapshot(2, thirdMidnight);
    await vi.advanceTimersByTimeAsync(secondMidnight - Date.now() + 1000);
    indicator.detectChanges(); settings.detectChanges();
    expect(statusApi).toHaveBeenCalledTimes(2);
    expect(settings.nativeElement.querySelector('p[role="status"]').textContent).toBe('Used today: 2 of 20');
    indicator.destroy(); settings.destroy();
  });

  it('reschedules event and manual refresh snapshots without retaining the old deadline', async () => {
    current = snapshot(3, secondMidnight);
    started?.();
    await Promise.resolve();
    expect(service.status()?.dailyUsage?.used).toBe(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusApi).toHaveBeenCalledTimes(1);
    current = snapshot(21, thirdMidnight);
    skipped?.({ dailyUsage: current.dailyUsage! });
    await Promise.resolve();
    expect(service.status()?.dailyUsage?.used).toBe(21);
    current = snapshot(4, thirdMidnight);
    await service.refreshStatus();
    expect(service.status()?.dailyUsage?.used).toBe(4);
    await vi.advanceTimersByTimeAsync(secondMidnight - Date.now() + 1000);
    expect(statusApi).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('invalidates expired usage when the midnight refresh fails and allows manual recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    statusApi.mockRejectedValueOnce(new Error('status unavailable'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.status()?.dailyUsage).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    current = snapshot(1, secondMidnight);
    await service.refreshStatus();
    expect(service.status()?.dailyUsage?.used).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    warn.mockRestore();
  });

  it('ignores a slower old response after a newer midnight refresh', async () => {
    let resolve!: (value: IpcResponse<CrossModelReviewStatus>) => void;
    statusApi.mockImplementationOnce(() => new Promise(next => { resolve = next; }));
    const earlier = service.refreshStatus();
    current = snapshot(1, secondMidnight);
    await vi.advanceTimersByTimeAsync(2000);
    resolve({ success: true, data: snapshot(20, firstMidnight) });
    await earlier;
    expect(service.status()?.dailyUsage).toEqual(current.dailyUsage);
    expect(statusApi).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('refetches a response crossing midnight once and bounds stale-backend retries', async () => {
    current = snapshot(20, firstMidnight);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.status()?.dailyUsage).toBeUndefined();
    expect(statusApi).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    current = snapshot(0, secondMidnight);
    await service.refreshStatus();
    expect(service.status()?.dailyUsage?.used).toBe(0);
  });

  it('clears the timer and prevents a pending response from rearming after service destruction', async () => {
    let resolve!: (value: IpcResponse<CrossModelReviewStatus>) => void;
    statusApi.mockImplementationOnce(() => new Promise(next => { resolve = next; }));
    const pending = service.refreshStatus();
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
    resolve({ success: true, data: snapshot(0, secondMidnight) });
    await pending;
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusApi).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.status()?.dailyUsage?.used).toBe(20);
  });
});
