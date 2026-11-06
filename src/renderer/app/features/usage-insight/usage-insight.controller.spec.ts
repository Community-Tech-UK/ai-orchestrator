import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageInsightResponse } from '../../../../shared/usage-insight/usage-insight.types';
import { UsageInsightIpcService } from '../../core/services/ipc/usage-insight-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { UsageInsightController, type UsageInsightView } from './usage-insight.controller';
import { presentUsageFailure } from './usage-insight-failure';
import { reportWith } from './usage-insight.test-helpers';

const SCANNING: UsageInsightResponse = { status: 'scanning', progress: { filesDone: 2, filesTotal: 9, bytesDone: 20, bytesTotal: 90 } };
const READY: UsageInsightResponse = { status: 'ready', report: reportWith({ longContext: 30 }), refreshing: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The share of the first cause that has a percentage, to tell one report from another. */
function cacheMissPercent(view: UsageInsightView): number | null | undefined {
  return view.phase === 'ready' ? view.report.causes.find((cause) => cause.id === 'cacheMiss')?.percent : undefined;
}

describe('UsageInsightController', () => {
  const get = vi.fn();
  let tick: () => unknown;
  const stopPolling = vi.fn();
  const register = vi.fn((callback: () => unknown) => { tick = callback; return stopPolling; });

  function create(): UsageInsightController {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        UsageInsightController,
        { provide: UsageInsightIpcService, useValue: { get } },
        { provide: RendererPollSchedulerService, useValue: { register } },
      ],
    });
    return TestBed.inject(UsageInsightController);
  }

  beforeEach(() => {
    get.mockReset();
    register.mockClear();
    stopPolling.mockClear();
  });

  it('starts out loading', () => {
    expect(create().view()).toEqual({ phase: 'loading' });
  });

  it('asks for every session by default and shows the report', async () => {
    get.mockResolvedValue({ success: true, data: READY });
    const controller = create();
    await controller.open(null);
    expect(get).toHaveBeenCalledWith({});
    expect(controller.view()).toMatchObject({ phase: 'ready', refreshing: false });
    expect(register).not.toHaveBeenCalled();
  });

  it('asks for one session when given one', async () => {
    get.mockResolvedValue({ success: true, data: READY });
    await create().open('inst-7');
    expect(get).toHaveBeenCalledWith({ instanceId: 'inst-7' });
  });

  describe('while the main process is still reading', () => {
    it('shows the progress and keeps asking until there is a report', async () => {
      get.mockResolvedValue({ success: true, data: SCANNING });
      const controller = create();
      await controller.open(null);
      expect(controller.view()).toEqual({ phase: 'scanning', progress: SCANNING.status === 'scanning' ? SCANNING.progress : undefined });
      expect(register).toHaveBeenCalledTimes(1);

      get.mockResolvedValue({ success: true, data: READY });
      await tick();
      expect(get).toHaveBeenCalledTimes(2);
      expect(controller.view()).toMatchObject({ phase: 'ready' });
      expect(stopPolling).toHaveBeenCalledTimes(1);
    });

    it('does not start a second poll while one is running', async () => {
      get.mockResolvedValue({ success: true, data: SCANNING });
      const controller = create();
      await controller.open(null);
      await tick();
      await tick();
      expect(register).toHaveBeenCalledTimes(1);
    });

    it('keeps the old report on screen while an update runs, and keeps asking', async () => {
      get.mockResolvedValue({ success: true, data: { ...READY, refreshing: true } });
      const controller = create();
      await controller.open(null);
      expect(controller.view()).toMatchObject({ phase: 'ready', refreshing: true });
      expect(register).toHaveBeenCalledTimes(1);
    });
  });

  describe('refresh', () => {
    it('asks the main process to read again and keeps the report meanwhile', async () => {
      get.mockResolvedValue({ success: true, data: READY });
      const controller = create();
      await controller.open(null);
      const pending = deferred<unknown>();
      get.mockReturnValue(pending.promise);
      const refreshing = controller.refresh();
      expect(controller.view().phase).toBe('ready');
      expect(get).toHaveBeenLastCalledWith({ refresh: true });
      pending.resolve({ success: true, data: { ...READY, refreshing: true } });
      await refreshing;
      expect(controller.view()).toMatchObject({ phase: 'ready', refreshing: true });
    });

    it('goes back to loading when there was no report to keep', async () => {
      get.mockResolvedValueOnce({ success: false, error: { message: 'nope' } });
      const controller = create();
      await controller.open(null);
      expect(controller.view().phase).toBe('error');
      const pending = deferred<unknown>();
      get.mockReturnValue(pending.promise);
      const retry = controller.refresh();
      expect(controller.view()).toEqual({ phase: 'loading' });
      pending.resolve({ success: true, data: READY });
      await retry;
      expect(controller.view().phase).toBe('ready');
    });
  });

  describe('when something goes wrong', () => {
    const RAW = "EACCES: permission denied, scandir '/Users/someone/.claude/projects'";

    function failureOf(view: UsageInsightView) {
      if (view.phase !== 'error') throw new Error(`expected the error view, got ${view.phase}`);
      return view.failure;
    }

    it('words the main process error with the shared presenter and keeps the raw text apart', async () => {
      get.mockResolvedValue({ success: true, data: { status: 'error', message: RAW } });
      const controller = create();
      await controller.open(null);
      expect(controller.view()).toEqual({ phase: 'error', failure: presentUsageFailure(RAW) });
      const failure = failureOf(controller.view());
      expect(failure.rawDetail).toBe(RAW);
      expect(failure.headline + failure.whatToDo).not.toMatch(/EACCES|\/Users/);
      expect(register).not.toHaveBeenCalled();
    });

    it('words a failed request the same way', async () => {
      get.mockResolvedValue({ success: false, error: { message: RAW } });
      const controller = create();
      await controller.open(null);
      const failure = failureOf(controller.view());
      expect(failure).toEqual(presentUsageFailure({ message: RAW }));
      expect(failure.rawDetail).toBe(RAW);
      expect(failure.headline + failure.whatToDo).not.toContain('EACCES');
    });

    it('words a request that throws the same way', async () => {
      get.mockRejectedValue(new Error(RAW));
      const controller = create();
      await controller.open(null);
      const failure = failureOf(controller.view());
      expect(failure).toEqual(presentUsageFailure(new Error(RAW)));
      expect(failure.rawDetail).toBe(RAW);
      expect(failure.headline + failure.whatToDo).not.toContain('EACCES');
    });

    it('says so when there is no answer at all', async () => {
      get.mockResolvedValue({ success: true });
      const controller = create();
      await controller.open(null);
      const failure = failureOf(controller.view());
      expect(failure.rawDetail).toBe('No answer from Harness.');
      expect(failure.headline.length).toBeGreaterThan(0);
    });

    it('keeps the report and shows the failure beside it when an update fails', async () => {
      get.mockResolvedValue({ success: true, data: READY });
      const controller = create();
      await controller.open(null);
      get.mockResolvedValue({ success: false, error: { message: 'timed out' } });
      await controller.refresh();
      const view = controller.view();
      expect(view).toMatchObject({ phase: 'ready', refreshing: false, refreshFailure: presentUsageFailure({ message: 'timed out' }) });
      expect(view.phase === 'ready' && view.refreshFailure?.rawDetail).toBe('timed out');
    });

    it("words the main process's own note about a failed update the same way", async () => {
      get.mockResolvedValue({ success: true, data: { ...READY, refreshError: RAW } });
      const controller = create();
      await controller.open(null);
      const view = controller.view();
      expect(view).toMatchObject({ phase: 'ready', refreshFailure: presentUsageFailure(RAW) });
      expect(view.phase === 'ready' && view.refreshFailure?.headline).not.toContain('EACCES');
    });

    it('shows no failure beside a report when the main process has none', async () => {
      get.mockResolvedValue({ success: true, data: READY });
      const controller = create();
      await controller.open(null);
      expect(controller.view()).not.toHaveProperty('refreshFailure');
    });
  });

  it('shows why a session cannot be broken down', async () => {
    get.mockResolvedValue({ success: true, data: { status: 'unsupported', reason: 'not-claude' } });
    const controller = create();
    await controller.open('inst-codex');
    expect(controller.view()).toEqual({ phase: 'unsupported', reason: 'not-claude' });
    expect(register).not.toHaveBeenCalled();
  });

  describe('changing session', () => {
    it('ignores a slow answer for the session that was shown before', async () => {
      const slow = deferred<unknown>();
      get.mockReturnValueOnce(slow.promise);
      const controller = create();
      const first = controller.open('inst-a');
      get.mockResolvedValueOnce({ success: true, data: { ...READY, report: reportWith({ cacheMiss: 55 }) } });
      await controller.open('inst-b');
      slow.resolve({ success: true, data: { ...READY, report: reportWith({ cacheMiss: 11 }) } });
      await first;
      expect(cacheMissPercent(controller.view())).toBe(55);
    });

    it('stops polling for the old session', async () => {
      get.mockResolvedValue({ success: true, data: SCANNING });
      const controller = create();
      await controller.open('inst-a');
      expect(register).toHaveBeenCalledTimes(1);
      get.mockResolvedValue({ success: true, data: READY });
      await controller.open('inst-b');
      expect(stopPolling).toHaveBeenCalledTimes(1);
    });
  });

  describe('overlapping requests for the same session', () => {
    it('ignores an older answer that arrives after a newer one, and does not start polling again', async () => {
      get.mockResolvedValueOnce({ success: true, data: SCANNING });
      const controller = create();
      await controller.open(null);
      expect(register).toHaveBeenCalledTimes(1);

      // A poll goes out and is slow. Then the reader presses Refresh, which is answered first.
      const olderPoll = deferred<unknown>();
      get.mockReturnValueOnce(olderPoll.promise);
      const poll = tick();
      const newerRefresh = deferred<unknown>();
      get.mockReturnValueOnce(newerRefresh.promise);
      const refreshing = controller.refresh();
      newerRefresh.resolve({ success: true, data: { ...READY, report: reportWith({ cacheMiss: 55 }) } });
      await refreshing;
      expect(cacheMissPercent(controller.view())).toBe(55);
      expect(stopPolling).toHaveBeenCalledTimes(1);

      olderPoll.resolve({ success: true, data: SCANNING });
      await poll;
      expect(controller.view().phase).toBe('ready');
      expect(cacheMissPercent(controller.view())).toBe(55);
      expect(register).toHaveBeenCalledTimes(1);
      expect(stopPolling).toHaveBeenCalledTimes(1);
    });

    it('does not let an older failure replace a newer report', async () => {
      get.mockResolvedValueOnce({ success: true, data: READY });
      const controller = create();
      await controller.open(null);

      const older = deferred<unknown>();
      get.mockReturnValueOnce(older.promise);
      const first = controller.refresh();
      const newer = deferred<unknown>();
      get.mockReturnValueOnce(newer.promise);
      const second = controller.refresh();
      newer.resolve({ success: true, data: { ...READY, report: reportWith({ cacheMiss: 55 }) } });
      await second;
      older.resolve({ success: false, error: { message: 'timed out' } });
      await first;

      expect(cacheMissPercent(controller.view())).toBe(55);
      expect(controller.view()).not.toHaveProperty('refreshFailure');
    });

    it('lets an older answer through when it arrives first, then replaces it with the newer one', async () => {
      get.mockResolvedValueOnce({ success: true, data: READY });
      const controller = create();
      await controller.open(null);

      const older = deferred<unknown>();
      get.mockReturnValueOnce(older.promise);
      const first = controller.refresh();
      const newer = deferred<unknown>();
      get.mockReturnValueOnce(newer.promise);
      const second = controller.refresh();
      older.resolve({ success: true, data: { ...READY, report: reportWith({ cacheMiss: 11 }) } });
      await first;
      expect(cacheMissPercent(controller.view())).toBe(11);
      newer.resolve({ success: true, data: { ...READY, report: reportWith({ cacheMiss: 55 }) } });
      await second;
      expect(cacheMissPercent(controller.view())).toBe(55);
    });

    it('skips a poll while another request is still waiting', async () => {
      get.mockResolvedValueOnce({ success: true, data: SCANNING });
      const controller = create();
      await controller.open(null);
      expect(get).toHaveBeenCalledTimes(1);

      const slow = deferred<unknown>();
      get.mockReturnValue(slow.promise);
      const first = tick();
      const second = tick();
      expect(get).toHaveBeenCalledTimes(2);
      slow.resolve({ success: true, data: SCANNING });
      await Promise.all([first, second]);

      get.mockResolvedValue({ success: true, data: READY });
      await tick();
      expect(get).toHaveBeenCalledTimes(3);
      expect(controller.view().phase).toBe('ready');
    });
  });

  describe('when the card goes away', () => {
    it('stops polling', async () => {
      get.mockResolvedValue({ success: true, data: SCANNING });
      const controller = create();
      await controller.open(null);
      expect(stopPolling).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      expect(stopPolling).toHaveBeenCalledTimes(1);
      expect(controller).toBeDefined();
    });

    it('ignores an answer that arrives afterwards and starts no polling', async () => {
      const slow = deferred<unknown>();
      get.mockReturnValueOnce(slow.promise);
      const controller = create();
      const opening = controller.open(null);
      TestBed.resetTestingModule();
      slow.resolve({ success: true, data: SCANNING });
      await opening;
      expect(register).not.toHaveBeenCalled();
      expect(controller.view()).toEqual({ phase: 'loading' });
    });

    it('ignores a poll answer that arrives afterwards', async () => {
      get.mockResolvedValueOnce({ success: true, data: SCANNING });
      const controller = create();
      await controller.open(null);
      const slow = deferred<unknown>();
      get.mockReturnValueOnce(slow.promise);
      const poll = tick();
      TestBed.resetTestingModule();
      slow.resolve({ success: true, data: READY });
      await poll;
      expect(controller.view().phase).toBe('scanning');
      expect(register).toHaveBeenCalledTimes(1);
    });

    it('does nothing when it is asked to open or refresh afterwards', async () => {
      const controller = create();
      TestBed.resetTestingModule();
      await controller.open('inst-a');
      await controller.refresh();
      expect(get).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    });
  });
});
