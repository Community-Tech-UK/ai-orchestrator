import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompareIpcService } from '../../core/services/ipc/compare-ipc.service';
import type { CouncilRun } from '../../core/services/ipc/compare-ipc.service';
import { AskCouncilStore } from './ask-council.store';

function makeRun(overrides: Partial<CouncilRun> = {}): CouncilRun {
  return {
    id: 'council-1',
    prompt: 'test prompt',
    createdAt: 1,
    members: [
      { provider: 'claude', status: 'succeeded', answer: 'Claude says hi', durationMs: 100 },
      { provider: 'gemini', status: 'running' },
    ],
    cancelled: false,
    ...overrides,
  };
}

function makeIpc(overrides: Partial<Record<keyof CompareIpcService, unknown>> = {}) {
  return {
    compareListProviders: vi.fn().mockResolvedValue({ success: true, data: ['claude', 'gemini'] }),
    compareGetRun: vi.fn().mockResolvedValue({ success: true, data: null }),
    compareStart: vi.fn(),
    compareCancel: vi.fn(),
    compareSynthesize: vi.fn(),
    onCompareRunUpdated: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function setupStore(ipc: ReturnType<typeof makeIpc>): AskCouncilStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [AskCouncilStore, { provide: CompareIpcService, useValue: ipc }],
  });
  return TestBed.inject(AskCouncilStore);
}

describe('AskCouncilStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  describe('initialize()', () => {
    it('loads providers and rehydrates the latest run', async () => {
      const ipc = makeIpc({
        compareGetRun: vi.fn().mockResolvedValue({ success: true, data: makeRun() }),
      });
      const store = setupStore(ipc);

      await store.initialize();

      expect(store.availableProviders()).toEqual(['claude', 'gemini']);
      expect(store.run()?.id).toBe('council-1');
    });

    it('leaves run null when there is nothing to rehydrate', async () => {
      const store = setupStore(makeIpc());
      await store.initialize();
      expect(store.run()).toBeNull();
    });

    it('is idempotent — a second call does not re-fetch', async () => {
      const ipc = makeIpc();
      const store = setupStore(ipc);
      await store.initialize();
      await store.initialize();
      expect(ipc.compareListProviders).toHaveBeenCalledOnce();
    });
  });

  describe('derived member signals', () => {
    it('isRunning is true while any member is queued or running', async () => {
      const store = setupStore(makeIpc());
      await store.initialize();
      const ipc2 = makeIpc({
        compareStart: vi.fn().mockResolvedValue({ success: true, data: makeRun() }),
      });
      const store2 = setupStore(ipc2);
      await store2.initialize();
      await store2.start('hi', ['claude', 'gemini']);

      expect(store2.isRunning()).toBe(true);
      expect(store2.succeededMembers()).toHaveLength(1);
    });

    it('canSynthesize requires at least 2 succeeded members', async () => {
      const oneDone = makeRun({ members: [{ provider: 'claude', status: 'succeeded', answer: 'x' }] });
      const ipc = makeIpc({ compareStart: vi.fn().mockResolvedValue({ success: true, data: oneDone }) });
      const store = setupStore(ipc);
      await store.initialize();
      await store.start('hi', ['claude']);
      expect(store.canSynthesize()).toBe(false);

      const twoDone = makeRun({
        members: [
          { provider: 'claude', status: 'succeeded', answer: 'x' },
          { provider: 'gemini', status: 'succeeded', answer: 'y' },
        ],
      });
      const ipc2 = makeIpc({ compareStart: vi.fn().mockResolvedValue({ success: true, data: twoDone }) });
      const store2 = setupStore(ipc2);
      await store2.initialize();
      await store2.start('hi', ['claude', 'gemini']);
      expect(store2.canSynthesize()).toBe(true);
    });

    it('canSynthesize does not require every member to be finished (N-1 progressive synthesis)', async () => {
      const run = makeRun({
        members: [
          { provider: 'claude', status: 'succeeded', answer: 'x' },
          { provider: 'gemini', status: 'succeeded', answer: 'y' },
          { provider: 'codex', status: 'running' },
        ],
      });
      const ipc = makeIpc({ compareStart: vi.fn().mockResolvedValue({ success: true, data: run }) });
      const store = setupStore(ipc);
      await store.initialize();
      await store.start('hi', ['claude', 'gemini', 'codex']);

      expect(store.isRunning()).toBe(true);
      expect(store.canSynthesize()).toBe(true);
    });
  });

  describe('start()', () => {
    it('sets the run from a successful compareStart response', async () => {
      const run = makeRun();
      const ipc = makeIpc({ compareStart: vi.fn().mockResolvedValue({ success: true, data: run }) });
      const store = setupStore(ipc);
      await store.initialize();

      await store.start('hi', ['claude', 'gemini'], '/tmp/wd');

      expect(ipc.compareStart).toHaveBeenCalledWith({ prompt: 'hi', providers: ['claude', 'gemini'], workingDirectory: '/tmp/wd' });
      expect(store.run()).toEqual(run);
    });

    it('sets errorMessage on failure and leaves run untouched', async () => {
      const ipc = makeIpc({
        compareStart: vi.fn().mockResolvedValue({ success: false, error: { message: 'no providers' } }),
      });
      const store = setupStore(ipc);
      await store.initialize();

      await store.start('hi', ['claude']);

      expect(store.errorMessage()).toBe('no providers');
      expect(store.run()).toBeNull();
    });
  });

  describe('cancel()', () => {
    it('replaces the run with the cancelled snapshot returned by the IPC call', async () => {
      const run = makeRun();
      const cancelled = { ...run, cancelled: true };
      const ipc = makeIpc({
        compareStart: vi.fn().mockResolvedValue({ success: true, data: run }),
        compareCancel: vi.fn().mockResolvedValue({ success: true, data: cancelled }),
      });
      const store = setupStore(ipc);
      await store.initialize();
      await store.start('hi', ['claude']);

      await store.cancel();

      expect(ipc.compareCancel).toHaveBeenCalledWith(run.id);
      expect(store.run()?.cancelled).toBe(true);
    });

    it('is a no-op when there is no active run', async () => {
      const ipc = makeIpc();
      const store = setupStore(ipc);
      await store.initialize();
      await store.cancel();
      expect(ipc.compareCancel).not.toHaveBeenCalled();
    });
  });

  describe('synthesize()', () => {
    it('does nothing when canSynthesize is false', async () => {
      const run = makeRun({ members: [{ provider: 'claude', status: 'succeeded', answer: 'x' }] });
      const ipc = makeIpc({ compareStart: vi.fn().mockResolvedValue({ success: true, data: run }) });
      const store = setupStore(ipc);
      await store.initialize();
      await store.start('hi', ['claude']);

      await store.synthesize('consensus');

      expect(ipc.compareSynthesize).not.toHaveBeenCalled();
    });

    it('calls compareSynthesize with the run id and method, and stores the result', async () => {
      const run = makeRun({
        members: [
          { provider: 'claude', status: 'succeeded', answer: 'x' },
          { provider: 'gemini', status: 'succeeded', answer: 'y' },
        ],
      });
      const synthesized = { ...run, synthesis: { method: 'consensus' as const, text: 'merged', attribution: [], generatedAt: 1 } };
      const ipc = makeIpc({
        compareStart: vi.fn().mockResolvedValue({ success: true, data: run }),
        compareSynthesize: vi.fn().mockResolvedValue({ success: true, data: synthesized }),
      });
      const store = setupStore(ipc);
      await store.initialize();
      await store.start('hi', ['claude', 'gemini']);

      await store.synthesize('consensus');

      expect(ipc.compareSynthesize).toHaveBeenCalledWith({ runId: run.id, method: 'consensus' });
      expect(store.synthesis()?.text).toBe('merged');
    });
  });

  describe('live updates', () => {
    it('only applies onCompareRunUpdated events matching the current run id', async () => {
      const run = makeRun();
      let pushUpdate: ((run: CouncilRun) => void) | undefined;
      const ipc = makeIpc({
        compareStart: vi.fn().mockResolvedValue({ success: true, data: run }),
        onCompareRunUpdated: vi.fn((cb: (run: CouncilRun) => void) => {
          pushUpdate = cb;
          return () => undefined;
        }),
      });
      const store = setupStore(ipc);
      await store.initialize();
      await store.start('hi', ['claude', 'gemini']);

      pushUpdate?.({ ...run, id: 'some-other-run', cancelled: true });
      expect(store.run()?.cancelled).toBe(false);

      const updatedSameRun = { ...run, members: [{ ...run.members[0] }, { provider: 'gemini', status: 'succeeded' as const, answer: 'done' }] };
      pushUpdate?.(updatedSameRun);
      expect(store.members().find((m) => m.provider === 'gemini')?.status).toBe('succeeded');
    });
  });

  describe('clearRun()', () => {
    it('resets run and errorMessage', async () => {
      const run = makeRun();
      const ipc = makeIpc({ compareStart: vi.fn().mockResolvedValue({ success: true, data: run }) });
      const store = setupStore(ipc);
      await store.initialize();
      await store.start('hi', ['claude']);

      store.clearRun();

      expect(store.run()).toBeNull();
      expect(store.errorMessage()).toBeNull();
    });
  });
});
