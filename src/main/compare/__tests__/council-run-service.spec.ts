import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CouncilRunService, type CouncilRunServiceDeps, type CouncilRunStoreLike } from '../council-run-service';
import type { ProviderInvokeDeps } from '../council-provider-invoke';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { CouncilRun } from '@contracts/schemas/command';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

// ─── test doubles ────────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ProviderControl {
  sendMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  settle: { resolve: (v: { content: string }) => void; reject: (e: unknown) => void };
}

/** createAdapter returns a controllable adapter per provider, keyed by provider name. */
function makeInvokeDeps(): { invoke: ProviderInvokeDeps; controls: Record<string, ProviderControl> } {
  const controls: Record<string, ProviderControl> = {};
  let clock = 0;
  const invoke: ProviderInvokeDeps = {
    resolveProvider: async (p) => p as never,
    createAdapter: (cliType) => {
      const provider = cliType as unknown as string;
      const d = deferred<{ content: string }>();
      const sendMessage = vi.fn(() => d.promise);
      const terminate = vi.fn(async () => undefined);
      controls[provider] = { sendMessage, terminate, settle: d };
      return { sendMessage, terminate } as unknown as CliAdapter;
    },
    now: () => (clock += 1),
  };
  return { invoke, controls };
}

function makeStore(seed: CouncilRun[] = []): CouncilRunStoreLike & { saveRun: ReturnType<typeof vi.fn> } {
  const byId = new Map(seed.map((r) => [r.id, r]));
  return {
    getRun: (id) => byId.get(id) ?? null,
    getLatest: () => {
      const all = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
      return all[0] ?? null;
    },
    loadAll: () => [...byId.values()],
    saveRun: vi.fn((run: CouncilRun) => {
      byId.set(run.id, run);
    }),
  };
}

function makeSynthesisDeps(): CouncilRunServiceDeps['synthesis'] & {
  consensusSynthesize: ReturnType<typeof vi.fn>;
  debateSynthesize: ReturnType<typeof vi.fn>;
  invokeProvider: ReturnType<typeof vi.fn>;
} {
  return {
    consensusSynthesize: vi.fn(() => ({ consensus: 'CONSENSUS_TEXT' })),
    debateSynthesize: vi.fn(async () => ({ synthesis: 'DEBATE_TEXT' })),
    invokeProvider: vi.fn(async () => ({ ok: true, answer: 'PROVIDER_TEXT' })),
  };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('CouncilRunService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startRun / per-member transitions', () => {
    it('starts every member queued and returns immediately (does not await any provider)', () => {
      const { invoke } = makeInvokeDeps();
      const store = makeStore();
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      const run = service.startRun('hello', ['claude', 'gemini']);

      expect(run.members).toHaveLength(2);
      expect(run.members.every((m) => m.status === 'queued' || m.status === 'running')).toBe(true);
      expect(run.cancelled).toBe(false);
      expect(store.saveRun).toHaveBeenCalled();
    });

    it('one provider failing does not block the other from succeeding (one-fails-others-proceed)', async () => {
      const { invoke, controls } = makeInvokeDeps();
      const store = makeStore();
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      const run = service.startRun('hello', ['claude', 'gemini']);
      await flushMicrotasks();

      controls['claude'].settle.reject(new Error('spawn ENOENT'));
      await flushMicrotasks();

      let current = service.getRun(run.id)!;
      expect(current.members.find((m) => m.provider === 'claude')).toMatchObject({
        status: 'failed',
        error: 'spawn ENOENT',
      });
      expect(current.members.find((m) => m.provider === 'gemini')?.status).toBe('running');

      controls['gemini'].settle.resolve({ content: 'gemini answer' });
      await flushMicrotasks();

      current = service.getRun(run.id)!;
      expect(current.members.find((m) => m.provider === 'gemini')).toMatchObject({
        status: 'succeeded',
        answer: 'gemini answer',
      });
    });

    it('emits run-updated with the first completed answer while the slowest provider is still running', async () => {
      vi.useFakeTimers();
      const controls: Record<string, { resolve: (v: { content: string }) => void }> = {};
      let clock = 0;
      const invoke: ProviderInvokeDeps = {
        resolveProvider: async (p) => p as never,
        createAdapter: (cliType) => {
          const provider = cliType as unknown as string;
          const delayMs = provider === 'claude' ? 10 : 500;
          return {
            sendMessage: vi.fn(
              () =>
                new Promise((resolve) => {
                  controls[provider] = { resolve };
                  setTimeout(() => resolve({ content: `${provider} answer` }), delayMs);
                }),
            ),
            terminate: vi.fn(async () => undefined),
          } as unknown as CliAdapter;
        },
        now: () => (clock += 1),
      };
      const store = makeStore();
      const events: CouncilRun[] = [];
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });
      service.on('run-updated', (run: CouncilRun) => events.push(run));

      const run = service.startRun('hello', ['claude', 'gemini']);

      await vi.advanceTimersByTimeAsync(10);
      let current = service.getRun(run.id)!;
      expect(current.members.find((m) => m.provider === 'claude')?.status).toBe('succeeded');
      expect(current.members.find((m) => m.provider === 'gemini')?.status).toBe('running');
      // At least one run-updated event was emitted before gemini resolves.
      expect(events.some((e) => e.members.find((m) => m.provider === 'claude')?.status === 'succeeded'
        && e.members.find((m) => m.provider === 'gemini')?.status !== 'succeeded')).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      current = service.getRun(run.id)!;
      expect(current.members.find((m) => m.provider === 'gemini')?.status).toBe('succeeded');
    });
  });

  describe('cancelRun', () => {
    it('marks queued/running members cancelled and terminates any live adapter', async () => {
      const { invoke, controls } = makeInvokeDeps();
      const store = makeStore();
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      const run = service.startRun('hello', ['claude', 'gemini']);
      await flushMicrotasks();
      expect(controls['claude'].sendMessage).toHaveBeenCalled();

      const cancelled = service.cancelRun(run.id);
      expect(cancelled.cancelled).toBe(true);
      expect(cancelled.members.every((m) => m.status === 'cancelled')).toBe(true);
      expect(controls['claude'].terminate).toHaveBeenCalled();
      expect(controls['gemini'].terminate).toHaveBeenCalled();
    });

    it('does not overwrite an already-cancelled member when its in-flight call later settles', async () => {
      const { invoke, controls } = makeInvokeDeps();
      const store = makeStore();
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      const run = service.startRun('hello', ['claude']);
      await flushMicrotasks();
      service.cancelRun(run.id);

      // The in-flight sendMessage settles AFTER cancellation (e.g. terminate() didn't stop it in time).
      controls['claude'].settle.resolve({ content: 'too late' });
      await flushMicrotasks();

      const current = service.getRun(run.id)!;
      expect(current.members[0].status).toBe('cancelled');
    });

    it('is idempotent — cancelling an already-cancelled run is a no-op', async () => {
      const { invoke } = makeInvokeDeps();
      const store = makeStore();
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      const run = service.startRun('hello', ['claude']);
      const first = service.cancelRun(run.id);
      const second = service.cancelRun(run.id);
      expect(second).toEqual(first);
    });

    it('does not flip a queued member to running after the run was cancelled before it started', async () => {
      const { invoke } = makeInvokeDeps();
      const store = makeStore();
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      const run = service.startRun('hello', ['claude']);
      // Cancel synchronously, before the queued member's own async chain reaches its first `await`... in
      // practice runMember flips to 'running' synchronously before its first await, so this proves the
      // guard inside runMember (checked again after the resolveProvider await) still holds cancellation.
      service.cancelRun(run.id);
      await flushMicrotasks();

      const current = service.getRun(run.id)!;
      expect(current.members[0].status).toBe('cancelled');
    });
  });

  describe('getRun / rehydrate', () => {
    it('rehydrates a partially-complete run from the store on construction (simulated app restart)', () => {
      const seededRun: CouncilRun = {
        id: 'council-seed-1',
        prompt: 'seeded prompt',
        createdAt: 100,
        members: [
          { provider: 'claude', status: 'succeeded', answer: 'seeded answer', durationMs: 5 },
          { provider: 'gemini', status: 'failed', error: 'boom' },
        ],
        cancelled: false,
      };
      const { invoke } = makeInvokeDeps();
      const store = makeStore([seededRun]);
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      expect(service.getRun('council-seed-1')).toEqual(seededRun);
      expect(service.getRun()).toEqual(seededRun);
    });

    it('getRun with no id returns the most recently created run', () => {
      const older: CouncilRun = { id: 'a', prompt: 'p', createdAt: 1, members: [], cancelled: false };
      const newer: CouncilRun = { id: 'b', prompt: 'p', createdAt: 2, members: [], cancelled: false };
      const { invoke } = makeInvokeDeps();
      const store = makeStore([older, newer]);
      const service = new CouncilRunService({ invoke, store, synthesis: makeSynthesisDeps() });

      expect(service.getRun()?.id).toBe('b');
    });

    it('returns null for an unknown run id', () => {
      const { invoke } = makeInvokeDeps();
      const service = new CouncilRunService({ invoke, store: makeStore(), synthesis: makeSynthesisDeps() });
      expect(service.getRun('nope')).toBeNull();
    });
  });

  describe('synthesizeRun', () => {
    function makeCompletedRun(overrides: Partial<CouncilRun> = {}): CouncilRun {
      return {
        id: 'council-done-1',
        prompt: 'What should we build?',
        createdAt: 1,
        members: [
          { provider: 'claude', status: 'succeeded', answer: 'Build A', durationMs: 10 },
          { provider: 'gemini', status: 'succeeded', answer: 'Build A too', durationMs: 20 },
          { provider: 'codex', status: 'failed', error: 'timed out', durationMs: 5 },
        ],
        cancelled: false,
        ...overrides,
      };
    }

    it('rejects when fewer than 2 members completed (not N-1-safe below the floor)', async () => {
      const oneDone: CouncilRun = {
        id: 'council-one',
        prompt: 'q',
        createdAt: 1,
        members: [{ provider: 'claude', status: 'succeeded', answer: 'only one' }],
        cancelled: false,
      };
      const { invoke } = makeInvokeDeps();
      const service = new CouncilRunService({ invoke, store: makeStore([oneDone]), synthesis: makeSynthesisDeps() });

      await expect(service.synthesizeRun('council-one', 'consensus')).rejects.toThrow(/at least 2/i);
    });

    it('works with N-1 members (one of three failed) via the consensus method', async () => {
      const run = makeCompletedRun();
      const { invoke } = makeInvokeDeps();
      const synthesis = makeSynthesisDeps();
      const service = new CouncilRunService({ invoke, store: makeStore([run]), synthesis });

      const updated = await service.synthesizeRun(run.id, 'consensus');

      expect(synthesis.consensusSynthesize).toHaveBeenCalledOnce();
      const responses = synthesis.consensusSynthesize.mock.calls[0][0];
      expect(responses).toHaveLength(3); // all 3 members passed through, including the absent one
      expect(responses.find((r: { provider: string }) => r.provider === 'codex')).toMatchObject({ success: false });
      expect(updated.synthesis).toMatchObject({ method: 'consensus', text: 'CONSENSUS_TEXT' });
      expect(updated.synthesis?.attribution).toEqual([
        { provider: 'claude', included: true, reason: undefined },
        { provider: 'gemini', included: true, reason: undefined },
        { provider: 'codex', included: false, reason: 'failed: timed out' },
      ]);
    });

    it('routes the debate method through debateSynthesize with succeeded-only contributions + absent context', async () => {
      const run = makeCompletedRun();
      const { invoke } = makeInvokeDeps();
      const synthesis = makeSynthesisDeps();
      const service = new CouncilRunService({ invoke, store: makeStore([run]), synthesis });

      const updated = await service.synthesizeRun(run.id, 'debate');

      expect(synthesis.debateSynthesize).toHaveBeenCalledOnce();
      const [query, contributions, context] = synthesis.debateSynthesize.mock.calls[0];
      expect(query).toBe(run.prompt);
      expect(contributions).toHaveLength(2);
      expect(contributions.map((c: { agentId: string }) => c.agentId)).toEqual(['claude', 'gemini']);
      expect(context).toContain('codex');
      expect(updated.synthesis).toMatchObject({ method: 'debate', text: 'DEBATE_TEXT' });
    });

    it('routes the {providerId} method through the compare service invocation path', async () => {
      const run = makeCompletedRun();
      const { invoke } = makeInvokeDeps();
      const synthesis = makeSynthesisDeps();
      const service = new CouncilRunService({ invoke, store: makeStore([run]), synthesis });

      const updated = await service.synthesizeRun(run.id, { providerId: 'claude' });

      expect(synthesis.invokeProvider).toHaveBeenCalledOnce();
      const [providerId, prompt] = synthesis.invokeProvider.mock.calls[0];
      expect(providerId).toBe('claude');
      expect(prompt).toContain('What should we build?');
      expect(updated.synthesis).toMatchObject({ method: { providerId: 'claude' }, text: 'PROVIDER_TEXT' });
    });

    it('records a synthesis error (not a throw) when the routed method fails', async () => {
      const run = makeCompletedRun();
      const { invoke } = makeInvokeDeps();
      const synthesis = makeSynthesisDeps();
      synthesis.invokeProvider.mockResolvedValueOnce({ ok: false, error: 'provider unavailable' });
      const service = new CouncilRunService({ invoke, store: makeStore([run]), synthesis });

      const updated = await service.synthesizeRun(run.id, { providerId: 'claude' });

      expect(updated.synthesis?.error).toBe('provider unavailable');
      expect(updated.synthesis?.text).toBe('');
    });
  });
});
