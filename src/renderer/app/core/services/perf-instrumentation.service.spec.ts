import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingIpcService } from './ipc/logging-ipc.service';
import { PerfInstrumentationService } from './perf-instrumentation.service';

describe('PerfInstrumentationService log export', () => {
  const logMessage = vi.fn().mockResolvedValue({ success: true });
  let service: PerfInstrumentationService;

  beforeEach(() => {
    vi.useFakeTimers();
    logMessage.mockClear();
    TestBed.configureTestingModule({
      providers: [
        PerfInstrumentationService,
        { provide: LoggingIpcService, useValue: { logMessage } },
      ],
    });
    service = TestBed.inject(PerfInstrumentationService);
    service.enable();
  });

  afterEach(() => {
    service.ngOnDestroy();
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('exports bounded aggregate metrics to the main-process logger', async () => {
    service.record({
      name: 'thread-switch',
      category: 'switch',
      duration: 80,
      timestamp: 1,
      metadata: { privateDetail: 'must-not-be-forwarded' },
    });
    service.record({
      name: 'thread-switch',
      category: 'switch',
      duration: 100,
      timestamp: 2,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(logMessage).toHaveBeenCalledWith(
      'debug',
      'Renderer performance metrics',
      'PerfInstrumentation',
      expect.objectContaining({
        entryCount: 2,
        summaries: [expect.objectContaining({ metric: 'thread-switch', count: 2, p95: 100 })],
      }),
    );
    expect(JSON.stringify(logMessage.mock.calls[0])).not.toContain('privateDetail');
  });
});
