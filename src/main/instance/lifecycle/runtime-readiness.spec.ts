import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { RuntimeReadinessCoordinator } from './runtime-readiness';
import type { RuntimeReadinessDeps } from './runtime-readiness';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { InstanceStatus } from '../../../shared/types/instance.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdapter(name = 'claude-cli'): EventEmitter & {
  getName(): string;
  formatter?: { isWritable(): boolean } | null;
  getResumeAttemptResult?: () => unknown;
} {
  const emitter = new EventEmitter() as EventEmitter & {
    getName(): string;
    formatter?: { isWritable(): boolean } | null;
    getResumeAttemptResult?: () => unknown;
  };
  emitter.getName = vi.fn(() => name);
  emitter.formatter = null;
  return emitter;
}

function makeDeps(
  adapter: CliAdapter | undefined,
  processId: number | null = 1,
  status: InstanceStatus = 'busy',
  loadMultiplier = 1,
): RuntimeReadinessDeps {
  return {
    getInstance: (_id) => ({ processId, status }),
    getAdapter: (_id) => adapter,
    // Pin the resume-health window scaling so timer-driven tests are
    // deterministic regardless of the host's real load.
    getResumeHealthLoadMultiplier: () => loadMultiplier,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RuntimeReadinessCoordinator.getAdapterRuntimeCapabilities', () => {
  it('returns default capabilities when adapter has no getRuntimeCapabilities', () => {
    const coord = new RuntimeReadinessCoordinator(makeDeps(undefined));
    const caps = coord.getAdapterRuntimeCapabilities(undefined);
    expect(caps.supportsResume).toBe(false);
    expect(caps.supportsNativeCompaction).toBe(false);
  });

  it('delegates to adapter.getRuntimeCapabilities when available', () => {
    const adapter = makeAdapter() as unknown as CliAdapter & {
      getRuntimeCapabilities: () => ReturnType<RuntimeReadinessCoordinator['getAdapterRuntimeCapabilities']>;
    };
    (adapter as unknown as { getRuntimeCapabilities: () => unknown }).getRuntimeCapabilities = vi.fn(() => ({
      supportsResume: true,
      supportsForkSession: true,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    }));
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter));
    const caps = coord.getAdapterRuntimeCapabilities(adapter);
    expect(caps.supportsResume).toBe(true);
  });
});

describe('RuntimeReadinessCoordinator.waitForResumeHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns false when adapter is not live (no adapter)', async () => {
    const coord = new RuntimeReadinessCoordinator(makeDeps(undefined));
    const result = await coord.waitForResumeHealth('inst-1');
    expect(result).toBe(false);
  });

  it('returns false when adapter is not live (instance terminated)', async () => {
    const adapter = makeAdapter() as unknown as CliAdapter;
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter, 1, 'terminated'));
    const result = await coord.waitForResumeHealth('inst-1');
    expect(result).toBe(false);
  });

  it('returns false when instance has no processId', async () => {
    const adapter = makeAdapter() as unknown as CliAdapter;
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter, null));
    const result = await coord.waitForResumeHealth('inst-1');
    expect(result).toBe(false);
  });

  it('resolves false when adapter emits a session-not-found error event', async () => {
    const adapter = makeAdapter();
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter as unknown as CliAdapter));

    const healthPromise = coord.waitForResumeHealth('inst-1', 5000, 200);
    adapter.emit('error', new Error('session not found'));

    const result = await healthPromise;
    expect(result).toBe(false);
  });

  it('resolves false when adapter emits session-not-found as error output message', async () => {
    const adapter = makeAdapter();
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter as unknown as CliAdapter));

    const healthPromise = coord.waitForResumeHealth('inst-1', 5000, 200);
    adapter.emit('output', {
      id: 'msg-1',
      type: 'error',
      content: 'no conversation found for this session id',
      timestamp: Date.now(),
    });

    const result = await healthPromise;
    expect(result).toBe(false);
  });

  it('resolves true when adapter emits normal output with no resume proof', async () => {
    const adapter = makeAdapter();
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter as unknown as CliAdapter));

    const healthPromise = coord.waitForResumeHealth('inst-1', 5000, 200);
    adapter.emit('output', 'Hello from assistant');

    const result = await healthPromise;
    expect(result).toBe(true);
  });

  it('resolves immediately when a quiet adapter has definitive native-resume proof', async () => {
    const adapter = makeAdapter('codex-cli');
    adapter.getResumeAttemptResult = vi.fn(() => ({
      source: 'native',
      confirmed: true,
      requestedSessionId: 'thread-1',
      actualSessionId: 'thread-1',
    }));
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter as unknown as CliAdapter));
    let result: boolean | undefined;

    void coord.waitForResumeHealth('inst-1', 5_000, 200).then((value) => {
      result = value;
    });
    await Promise.resolve();

    expect(result).toBe(true);
  });

  it('resolves false on timeout when instance is not live', async () => {
    const adapter = makeAdapter() as unknown as CliAdapter;
    const deps: RuntimeReadinessDeps = {
      getInstance: (id) => (id === 'inst-1' ? { processId: 1, status: 'busy' as InstanceStatus } : undefined),
      getAdapter: (_id) => adapter,
      getResumeHealthLoadMultiplier: () => 1,
    };
    const coord = new RuntimeReadinessCoordinator(deps);

    const healthPromise = coord.waitForResumeHealth('inst-1', 100, 50);
    vi.advanceTimersByTime(200);

    const result = await healthPromise;
    // Timeout with alive instance and no writable formatter (claude-cli): false
    expect(result).toBe(false);
  });

  it('resolves true on timeout when adapter is claude-cli with writable formatter', async () => {
    const adapter = makeAdapter('claude-cli');
    adapter.formatter = { isWritable: vi.fn(() => true) };
    const deps: RuntimeReadinessDeps = {
      getInstance: (_id) => ({ processId: 1, status: 'busy' as InstanceStatus }),
      getAdapter: (_id) => adapter as unknown as CliAdapter,
    };
    const coord = new RuntimeReadinessCoordinator(deps);

    const healthPromise = coord.waitForResumeHealth('inst-1', 100, 50);
    vi.advanceTimersByTime(200);

    const result = await healthPromise;
    expect(result).toBe(true);
  });
});

describe('RuntimeReadinessCoordinator.evaluateResumeHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('reports unrecoverable when the adapter is gone', async () => {
    const coord = new RuntimeReadinessCoordinator(makeDeps(undefined));
    await expect(coord.evaluateResumeHealth('inst-1')).resolves.toBe('unrecoverable');
  });

  it('reports unrecoverable on a session-not-found error event', async () => {
    const adapter = makeAdapter();
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter as unknown as CliAdapter));

    const verdict = coord.evaluateResumeHealth('inst-1', 5000, 200);
    adapter.emit('error', new Error('session not found'));

    await expect(verdict).resolves.toBe('unrecoverable');
  });

  it('reports unrecoverable when the adapter confirms a wrong session id', async () => {
    const adapter = makeAdapter('codex-cli');
    adapter.getResumeAttemptResult = vi.fn(() => ({
      source: 'native',
      confirmed: true,
      requestedSessionId: 'thread-1',
      actualSessionId: 'thread-other',
    }));
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter as unknown as CliAdapter));
    await expect(coord.evaluateResumeHealth('inst-1')).resolves.toBe('unrecoverable');
  });

  it('reports healthy on definitive native-resume proof', async () => {
    const adapter = makeAdapter('codex-cli');
    adapter.getResumeAttemptResult = vi.fn(() => ({
      source: 'native',
      confirmed: true,
      requestedSessionId: 'thread-1',
      actualSessionId: 'thread-1',
    }));
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter as unknown as CliAdapter));
    await expect(coord.evaluateResumeHealth('inst-1')).resolves.toBe('healthy');
  });

  it('reports inconclusive — NOT unrecoverable — when a live process is unproven at timeout', async () => {
    // The core resilience change: a slow-but-alive resume must not be classified
    // as dead. This is what stops the destructive fresh-fallback that lost
    // in-flight background work.
    const adapter = makeAdapter() as unknown as CliAdapter; // claude-cli, formatter null (not writable)
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter, 1, 'busy', 1));

    const verdict = coord.evaluateResumeHealth('inst-1', 100, 50);
    vi.advanceTimersByTime(200);

    await expect(verdict).resolves.toBe('inconclusive');
  });

  it('reports healthy at timeout when a quiet Claude stream is writable', async () => {
    const adapter = makeAdapter('claude-cli');
    adapter.formatter = { isWritable: vi.fn(() => true) };
    const coord = new RuntimeReadinessCoordinator(
      makeDeps(adapter as unknown as CliAdapter, 1, 'busy', 1),
    );

    const verdict = coord.evaluateResumeHealth('inst-1', 100, 50);
    vi.advanceTimersByTime(200);

    await expect(verdict).resolves.toBe('healthy');
  });

  it('stretches the health window by the load multiplier before giving up', async () => {
    // With base 100ms × multiplier 3 = 300ms window, a probe must still be
    // pending at 150ms and only settle once the scaled window elapses.
    const adapter = makeAdapter() as unknown as CliAdapter; // not writable, no proof
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter, 1, 'busy', 3));

    let settled: string | undefined;
    void coord.evaluateResumeHealth('inst-1', 100, 50).then((v) => {
      settled = v;
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(settled).toBeUndefined(); // would have fired at 100ms without scaling

    await vi.advanceTimersByTimeAsync(200); // now past 300ms scaled window
    expect(settled).toBe('inconclusive');
  });
});

describe('RuntimeReadinessCoordinator.waitForAdapterWritable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns true immediately for non-claude adapters', async () => {
    const adapter = makeAdapter('gemini-cli') as unknown as CliAdapter;
    const coord = new RuntimeReadinessCoordinator(makeDeps(adapter));

    const result = await coord.waitForAdapterWritable('inst-1');
    expect(result).toBe(true);
  });

  it('polls until claude-cli formatter becomes writable', async () => {
    const adapter = makeAdapter('claude-cli');
    let writable = false;
    adapter.formatter = { isWritable: vi.fn(() => writable) };
    const deps: RuntimeReadinessDeps = {
      getInstance: (_id) => ({ processId: 1, status: 'busy' as InstanceStatus }),
      getAdapter: (_id) => adapter as unknown as CliAdapter,
    };
    const coord = new RuntimeReadinessCoordinator(deps);

    const writablePromise = coord.waitForAdapterWritable('inst-1', 3000, 100);

    // Not writable yet — advance timers a bit and then flip writable
    vi.advanceTimersByTime(100);
    writable = true;
    vi.advanceTimersByTime(100);

    const result = await writablePromise;
    expect(result).toBe(true);
  });

  it('resolves after timeout when claude-cli formatter stays non-writable', async () => {
    const adapter = makeAdapter('claude-cli');
    adapter.formatter = { isWritable: vi.fn(() => false) };
    const deps: RuntimeReadinessDeps = {
      getInstance: (_id) => ({ processId: 1, status: 'busy' as InstanceStatus }),
      getAdapter: (_id) => adapter as unknown as CliAdapter,
    };
    const coord = new RuntimeReadinessCoordinator(deps);

    const writablePromise = coord.waitForAdapterWritable('inst-1', 500, 100);
    vi.advanceTimersByTime(600);

    const result = await writablePromise;
    // Times out, returns current state (false)
    expect(result).toBe(false);
  });

  it('returns false when adapter is not found', async () => {
    const deps: RuntimeReadinessDeps = {
      getInstance: (_id) => ({ processId: 1, status: 'busy' as InstanceStatus }),
      getAdapter: (_id) => undefined,
    };
    const coord = new RuntimeReadinessCoordinator(deps);

    const writablePromise = coord.waitForAdapterWritable('inst-1', 100, 50);
    vi.advanceTimersByTime(200);

    const result = await writablePromise;
    expect(result).toBe(false);
  });
});
