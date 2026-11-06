import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./codex/app-server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/app-server-client')>();
  return { ...actual, terminateProcessTree: vi.fn() };
});

// Child-rollout reconciliation reads files, so it is the slow step between a turn
// ending and its reply being published. Tests hold it open to widen that window.
const rolloutRead = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('./codex/child-rollout-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/child-rollout-usage')>();
  return {
    ...actual,
    readChildRolloutUsage: async (...args: Parameters<typeof actual.readChildRolloutUsage>) => {
      if (rolloutRead.gate) await rolloutRead.gate;
      return actual.readChildRolloutUsage(...args);
    },
  };
});

import { CodexCliAdapter } from './codex-cli-adapter';
import { AppServerNotificationHub } from './codex/app-server-notification-hub';
import type { AppServerNotification } from './codex/app-server-types';

vi.setConfig({ testTimeout: 30_000 });

// LT-683: three unsteered fourteen-turn native goals finished in their rollouts, but
// Harness published two distinct assistant turns per run, stayed busy, and the next
// send steered a turn id Codex no longer had. These tests replay the wire sequences
// through the real adapter and thread runtime, with only the app-server faked.

interface Notification { method: string; params: Record<string, unknown> }
type RpcHandler = (method: string, params: Record<string, unknown>) => unknown;
type Wire = [string, Record<string, unknown>][];

const THREAD = 'thread-1';
const GOAL_TURNS = 14;

interface Harness {
  adapter: CodexCliAdapter;
  /** One notification, dispatched synchronously through the real notification hub. */
  emit(method: string, params: Record<string, unknown>): void;
  /** A whole chunk: every notification dispatched before any promise continuation can run. */
  burst(notifications: Wire): void;
  requests: [string, Record<string, unknown>][];
  outputs: { id?: string; type: string; content: string; metadata?: Record<string, unknown> }[];
  statuses: string[];
  completions: string[];
  turnErrors: Error[];
  /** Exceptions thrown by notification handlers: the hub logs and swallows them in production. */
  handlerErrors: unknown[];
  subscriberCount(): number;
  hasActiveTurn(): boolean;
  currentTurnId(): string | null;
  /** Reconnects the same adapter object to the same fake app-server after `terminate`. */
  revive(): void;
  replaceThread(threadId: string): void;
}

const created: Harness[] = [];

function createHarness(rpc: RpcHandler = () => ({})): Harness {
  const adapter = new CodexCliAdapter();
  const handlerErrors: unknown[] = [];
  const hub = new AppServerNotificationHub((_notification, error) => { handlerErrors.push(error); });
  let subscribers = 0;
  const requests: Harness['requests'] = [];
  const client = {
    exitPromise: new Promise<void>(() => { /* stays connected */ }),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push([method, params]);
      return rpc(method, params);
    }),
    subscribeNotifications(handler: (notification: Notification) => void) {
      const unsubscribe = hub.subscribe(handler);
      subscribers += 1;
      let released = false;
      return () => {
        if (!released) subscribers -= 1;
        released = true;
        unsubscribe();
      };
    },
    isRunning: () => true,
    getPid: () => 4242,
  };
  const internals = adapter as unknown as {
    appServerClient: typeof client;
    appServerThreadId: string;
    useAppServer: boolean;
    isSpawned: boolean;
    appServerRuntime: {
      attach(c: typeof client, binding: unknown, onNotification: (n: Notification) => void): void;
      hasActiveTurn(): boolean;
      getCurrentTurnId(): string | null;
      replaceBinding(binding: { threadId: string; resumeCursor: null; resumeProof: null }): void;
    };
    handleIdleAppServerNotification(notification: Notification): void;
  };
  const connect = () => {
    internals.appServerClient = client;
    internals.appServerThreadId = THREAD;
    internals.useAppServer = true;
    internals.isSpawned = true;
    internals.appServerRuntime.attach(
      client,
      { threadId: THREAD, resumeCursor: null, resumeProof: null },
      (notification) => internals.handleIdleAppServerNotification(notification),
    );
  };
  connect();
  const outputs: Harness['outputs'] = [];
  const statuses: string[] = [];
  const completions: string[] = [];
  const turnErrors: Error[] = [];
  adapter.on('output', (output: Harness['outputs'][number]) => outputs.push(output));
  adapter.on('status', (status: string) => statuses.push(status));
  adapter.on('complete', (response: { content: string }) => completions.push(response.content));
  adapter.on('turn_error', (error: Error) => turnErrors.push(error));
  const emit: Harness['emit'] = (method, params) => hub.dispatch({ method, params } as AppServerNotification);
  const harness: Harness = {
    adapter,
    emit,
    burst: (notifications) => { for (const [method, params] of notifications) emit(method, params); },
    requests,
    outputs,
    statuses,
    completions,
    turnErrors,
    handlerErrors,
    subscriberCount: () => subscribers,
    hasActiveTurn: () => internals.appServerRuntime.hasActiveTurn(),
    currentTurnId: () => internals.appServerRuntime.getCurrentTurnId(),
    revive: connect,
    replaceThread: (threadId) => {
      internals.appServerRuntime.replaceBinding({ threadId, resumeCursor: null, resumeProof: null });
      internals.appServerThreadId = threadId;
    },
  };
  created.push(harness);
  return harness;
}

const started = (turnId: string): Wire[number] =>
  ['turn/started', { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } }];
const answer = (turnId: string, text: string): Wire[number] =>
  ['item/completed', { threadId: THREAD, turnId, item: { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text } }];
/** A message that is not the turn's final answer, so nothing infers the turn is over. */
const commentary = (turnId: string, text: string): Wire[number] =>
  ['item/completed', { threadId: THREAD, turnId, item: { id: `${turnId}-note`, type: 'agentMessage', phase: 'commentary', text } }];
const completed = (turnId: string, status = 'completed'): Wire[number] =>
  ['turn/completed', { threadId: THREAD, turn: { id: turnId, status } }];
const goalStatus = (status: string): Wire[number] =>
  ['thread/goal/updated', { threadId: THREAD, turnId: null, goal: { threadId: THREAD, objective: 'fourteen turns', status } }];

/** One complete native goal turn as Codex writes it. */
function goalTurn(index: number): Wire {
  const turnId = `goal-turn-${index}`;
  return [started(turnId), answer(turnId, `Reply ${index}`), completed(turnId)];
}

/** `count` consecutive goal turns, numbered from `from`. */
function goalTurns(count: number, from = 1): Wire {
  return Array.from({ length: count }, (_, i) => goalTurn(from + i)).flat();
}

function replies(count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, i) => `Reply ${from + i}`);
}

const methods = (h: Harness) => h.requests.map(([method]) => method);
const send = (h: Harness, text: string): Promise<void> =>
  (h.adapter as unknown as { sendInputImpl(message: string): Promise<void> }).sendInputImpl(text);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Polls quickly: the chunking sweeps wait many times. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 2 });

/** Answers each `turn/start` with the next `user-turn-N` id. */
function userTurnRpc(extra: RpcHandler = () => ({})): RpcHandler {
  let turns = 0;
  return (method, params) => (method === 'turn/start'
    ? { turn: { id: `user-turn-${turns += 1}`, status: 'inProgress' } }
    : extra(method, params));
}

/** A Harness send whose turn creates the goal; it has ended on the wire before this resolves. */
async function sendGoalTurn(h: Harness): Promise<void> {
  const sending = send(h, 'Set a fourteen turn goal.');
  await vi.waitFor(() => expect(methods(h)).toContain('turn/start'));
  h.burst([started('user-turn-1'), answer('user-turn-1', 'Goal set.'), completed('user-turn-1')]);
  await sending;
}

/** Delivers one goal turn's notifications one macrotask at a time, as a quiet machine would. */
async function deliverOrderly(h: Harness, wire: Wire): Promise<void> {
  for (const [method, params] of wire) {
    h.emit(method, params);
    await tick();
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Splits a wire into chunks at seeded positions. Between chunks nothing runs, one
 * promise hop runs (a capture tears down but nothing else), or timers and I/O run.
 */
async function deliverChunked(h: Harness, wire: Wire, seed: number): Promise<void> {
  const random = mulberry32(seed);
  for (let at = 0; at < wire.length;) {
    const size = 1 + Math.floor(random() * 10);
    h.burst(wire.slice(at, at + size));
    at += size;
    const gap = random();
    if (gap >= 0.67) await tick();
    else if (gap >= 0.34) await Promise.resolve();
  }
}

const live: Harness[] = [];
function track(harness: Harness): Harness { live.push(harness); return harness; }

afterEach(async () => {
  rolloutRead.gate = null;
  for (const harness of live.splice(0)) await harness.adapter.terminate(false);
  // A handler that throws would be logged and swallowed in production; here it fails the test.
  for (const harness of created.splice(0)) expect(harness.handlerErrors).toEqual([]);
});

describe('CodexCliAdapter goal turns delivered in one chunk', () => {
  it('publishes every one of fourteen goal turns that arrive in a single chunk, then settles idle once', async () => {
    const h = track(createHarness());
    h.emit(...goalStatus('active'));

    h.burst(goalTurns(GOAL_TURNS));

    await vi.waitFor(() => expect(h.completions).toEqual(replies(GOAL_TURNS)));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.statuses.filter((status) => status === 'idle')).toHaveLength(1);
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.turnErrors).toEqual([]);
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });

  it('follows a still-running last turn of a chunk and finishes it when its completion arrives later', async () => {
    const h = track(createHarness());
    h.burst([...goalTurns(2), started('goal-turn-3'), answer('goal-turn-3', 'Reply 3')]);

    await vi.waitFor(() => expect(h.completions).toEqual(replies(2)));
    expect(h.currentTurnId()).toBe('goal-turn-3');
    expect(h.statuses.at(-1)).toBe('busy');

    h.emit(...completed('goal-turn-3'));
    await vi.waitFor(() => expect(h.completions).toEqual(replies(3)));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
  });

  it('publishes a goal run that shares its first chunk with the end of the Harness turn', async () => {
    const h = track(createHarness(userTurnRpc()));
    const sending = send(h, 'Set a fourteen turn goal.');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/start'));

    h.burst([
      started('user-turn-1'), answer('user-turn-1', 'Goal set.'), completed('user-turn-1'),
      ...goalTurns(GOAL_TURNS - 1),
    ]);

    await expect(sending).resolves.toBeUndefined();
    await vi.waitFor(() => expect(h.completions).toEqual(['Goal set.', ...replies(GOAL_TURNS - 1)]));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
  });

  it('keeps replies in turn order, and busy until the last is published, while rollout reads are slow', async () => {
    let release!: () => void;
    rolloutRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const h = track(createHarness());

    h.burst(goalTurns(5));
    await tick();
    expect(h.statuses).not.toContain('idle');
    expect(h.completions).toEqual([]);

    release();
    await vi.waitFor(() => expect(h.completions).toEqual(replies(5)));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.statuses.indexOf('idle')).toBe(h.statuses.length - 1);
    expect(h.hasActiveTurn()).toBe(false);
  });
});

describe('CodexCliAdapter goal turns that follow a Harness turn', () => {
  it('publishes a Harness-origin turn whose terminal was lost before the next native goal start', async () => {
    const h = track(createHarness(userTurnRpc()));
    const sending = send(h, 'Set a goal.');
    await eventually(() => expect(methods(h)).toContain('turn/start'));
    h.burst([started('user-turn-1'), commentary('user-turn-1', 'Goal set.'), ...goalTurn(1)]);

    await expect(sending).resolves.toBeUndefined();
    await eventually(() => expect(h.completions).toEqual(['Goal set.', 'Reply 1']));
    await eventually(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.turnErrors).toEqual([]);
  });

  // The live signature of LT-683: after the Harness turn, the first goal turn was
  // published and then every later one was lost, while the session stayed busy.
  it.each([
    ['the turn/start answer arrives before the start notification', 'answer-first'],
    ['the start notification arrives before the turn/start answer', 'notification-first'],
  ] as const)('publishes every orderly goal turn when %s', async (_name, order) => {
    let acknowledge!: () => void;
    const h = track(createHarness((method) => (method === 'turn/start'
      ? new Promise((resolve) => { acknowledge = () => resolve({ turn: { id: 'user-turn-1', status: 'inProgress' } }); })
      : {})));
    h.emit(...goalStatus('active'));
    const sending = send(h, 'Set a fourteen turn goal.');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/start'));
    if (order === 'answer-first') {
      acknowledge();
      await tick();
      await deliverOrderly(h, [started('user-turn-1'), answer('user-turn-1', 'Goal set.'), completed('user-turn-1')]);
    } else {
      h.emit(...started('user-turn-1'));
      await tick();
      acknowledge();
      await deliverOrderly(h, [answer('user-turn-1', 'Goal set.'), completed('user-turn-1')]);
    }
    await sending;

    for (let index = 1; index <= GOAL_TURNS; index += 1) await deliverOrderly(h, goalTurn(index));

    await vi.waitFor(() => expect(h.completions).toEqual(['Goal set.', ...replies(GOAL_TURNS)]));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.currentTurnId()).toBeNull();
    expect(h.turnErrors).toEqual([]);
  });

  it('accepts a send after the goal ran, starting a turn rather than steering the finished Harness turn', async () => {
    const h = track(createHarness(userTurnRpc()));
    h.emit(...goalStatus('active'));
    await sendGoalTurn(h);
    for (let index = 1; index <= 3; index += 1) await deliverOrderly(h, goalTurn(index));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    h.requests.length = 0;

    const followUp = send(h, 'What did you finish?');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/start'));
    h.burst([started('user-turn-2'), answer('user-turn-2', 'Everything.'), completed('user-turn-2')]);

    await expect(followUp).resolves.toBeUndefined();
    expect(methods(h)).not.toContain('turn/steer');
    expect(h.completions.at(-1)).toBe('Everything.');
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });

  it('stays busy when the Harness turn is still publishing as Codex starts the next goal turn', async () => {
    const h = track(createHarness(userTurnRpc()));
    h.emit(...goalStatus('active'));
    const sending = send(h, 'Set a fourteen turn goal.');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/start'));

    // Codex starts the goal turn 7-24 ms after the Harness turn ends, before that send has returned.
    h.burst([started('user-turn-1'), answer('user-turn-1', 'Goal set.'), completed('user-turn-1'), started('goal-turn-1')]);
    await sending;
    expect(h.currentTurnId()).toBe('goal-turn-1');
    expect(h.statuses.at(-1)).toBe('busy');

    h.burst([answer('goal-turn-1', 'Reply 1'), completed('goal-turn-1')]);
    await vi.waitFor(() => expect(h.completions).toEqual(['Goal set.', 'Reply 1']));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.statuses.filter((status) => status === 'idle')).toHaveLength(1);
  });
});

describe('CodexCliAdapter goal turns delivered one at a time', () => {
  it('publishes fourteen orderly goal turns, including turns that start while the previous reply publishes', async () => {
    const h = track(createHarness());
    h.emit(...goalStatus('active'));
    for (let index = 1; index <= GOAL_TURNS; index += 1) {
      const [begin, final, end] = goalTurn(index);
      h.emit(...begin);
      await tick();
      h.emit(...final);
      h.emit(...end);
      // Codex starts the next goal turn within milliseconds; the previous one may still be publishing.
      if (index % 2 === 0) await tick();
    }

    await vi.waitFor(() => expect(h.completions).toEqual(replies(GOAL_TURNS)));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.turnErrors).toEqual([]);
  });
});

describe('CodexCliAdapter goal turns however the wire is chunked', () => {
  const seeds = Array.from({ length: 30 }, (_, seed) => seed);

  it('publishes every goal turn, in order, and settles idle for any split of the notifications', async () => {
    for (const seed of seeds) {
      const h = track(createHarness());
      await deliverChunked(h, [goalStatus('active'), ...goalTurns(GOAL_TURNS), goalStatus('complete')], seed);

      await eventually(() => expect(h.completions, `seed ${seed}`).toEqual(replies(GOAL_TURNS)));
      await eventually(() => expect(h.statuses.at(-1), `seed ${seed}`).toBe('idle'));
      expect(h.hasActiveTurn(), `seed ${seed}`).toBe(false);
      expect(h.currentTurnId(), `seed ${seed}`).toBeNull();
      expect(h.turnErrors, `seed ${seed}`).toEqual([]);
      expect(h.outputs.filter((output) => output.type === 'error'), `seed ${seed}`).toEqual([]);
    }
  });

  it('publishes the Harness turn and every goal turn after it for any split of the notifications', async () => {
    for (const seed of seeds) {
      const h = track(createHarness(userTurnRpc()));
      const sending = send(h, 'Set a fourteen turn goal.');
      await eventually(() => expect(methods(h)).toContain('turn/start'));
      await deliverChunked(h, [
        goalStatus('active'),
        started('user-turn-1'), answer('user-turn-1', 'Goal set.'), completed('user-turn-1'),
        ...goalTurns(GOAL_TURNS),
      ], seed);

      await sending;
      await eventually(() => expect(h.completions.filter((reply) => reply !== 'Goal set.'), `seed ${seed}`).toEqual(replies(GOAL_TURNS)));
      await eventually(() => expect(h.statuses.at(-1), `seed ${seed}`).toBe('idle'));
      expect(h.completions.filter((reply) => reply === 'Goal set.'), `seed ${seed}`).toHaveLength(1);
      expect(h.hasActiveTurn(), `seed ${seed}`).toBe(false);
      expect(h.currentTurnId(), `seed ${seed}`).toBeNull();
      expect(h.turnErrors, `seed ${seed}`).toEqual([]);
    }
  });
});

describe('CodexCliAdapter repeated and missing terminal notifications', () => {
  it('finishes a queued turn with a missing terminal when the next root turn has already started', async () => {
    let release!: () => void;
    rolloutRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const h = track(createHarness());
    h.burst(goalTurn(1));
    await tick();
    h.burst([started('goal-turn-2'), commentary('goal-turn-2', 'Working on it.'), ...goalTurn(3)]);
    release();

    await eventually(() => expect(h.completions).toEqual(['Reply 1', 'Working on it.', 'Reply 3']));
    await eventually(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.turnErrors).toEqual([]);
  });

  it('does not close the live turn when an earlier finished turn replays its start', async () => {
    const h = track(createHarness());
    h.burst(goalTurn(1));
    await eventually(() => expect(h.statuses.at(-1)).toBe('idle'));
    h.emit(...started('goal-turn-2'));
    h.emit(...started('goal-turn-1'));
    await tick();

    expect(h.currentTurnId()).toBe('goal-turn-2');
    expect(h.completions).toEqual(['Reply 1']);
    h.burst([answer('goal-turn-2', 'Reply 2'), completed('goal-turn-2')]);
    await eventually(() => expect(h.completions).toEqual(replies(2)));
    await eventually(() => expect(h.statuses.at(-1)).toBe('idle'));
  });

  it('keeps draining queued turns past a replayed finished start while publication is blocked', async () => {
    let release!: () => void;
    rolloutRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const h = track(createHarness());
    h.burst(goalTurn(1));
    await tick();
    h.burst([...goalTurn(2), started('goal-turn-1'), ...goalTurn(3)]);
    expect(h.completions).toEqual([]);
    release();

    await eventually(() => expect(h.completions).toEqual(replies(3)));
    await eventually(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
  });

  it('ignores a duplicate completion and a replayed start of turns that already finished', async () => {
    const h = track(createHarness());
    h.burst(goalTurns(2));
    await vi.waitFor(() => expect(h.completions).toEqual(replies(2)));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    const outputsBefore = h.outputs.length;

    h.emit(...completed('goal-turn-2'));
    h.emit(...started('goal-turn-2'));
    h.emit(...started('goal-turn-1'));
    h.emit(...completed('goal-turn-1'));
    await tick();

    expect(h.hasActiveTurn()).toBe(false);
    expect(h.statuses.at(-1)).toBe('idle');
    expect(h.completions).toEqual(replies(2));
    expect(h.outputs).toHaveLength(outputsBefore);
  });

  it('ignores a replayed start that shares a chunk with the real completion', async () => {
    const h = track(createHarness());
    h.burst([...goalTurn(1), started('goal-turn-1'), completed('goal-turn-1')]);

    await vi.waitFor(() => expect(h.completions).toEqual(['Reply 1']));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.completions).toEqual(['Reply 1']);
  });

  it('follows a turn once when its start is repeated while it runs', async () => {
    const h = track(createHarness());
    h.burst([started('goal-turn-1'), started('goal-turn-1')]);
    await tick();
    h.emit(...started('goal-turn-1'));

    expect(h.statuses.filter((status) => status === 'busy')).toHaveLength(1);
    h.burst([answer('goal-turn-1', 'Reply 1'), completed('goal-turn-1')]);
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.completions).toEqual(['Reply 1']);
  });

  it('closes a turn whose completion never arrived when Codex starts the next one, and steers the live turn', async () => {
    const h = track(createHarness((method) => (method === 'turn/steer' ? { turnId: 'goal-turn-2' } : {})));
    // Without a final answer nothing else could end the first turn: the stall watchdog is 15 minutes away.
    h.burst([started('goal-turn-1'), commentary('goal-turn-1', 'Working on it.'), started('goal-turn-2')]);

    await vi.waitFor(() => expect(h.completions).toEqual(['Working on it.']));
    expect(h.currentTurnId()).toBe('goal-turn-2');
    // The late end of the closed turn must not close the one now running.
    h.emit(...completed('goal-turn-1'));
    await tick();
    expect(h.currentTurnId()).toBe('goal-turn-2');
    expect(h.statuses.at(-1)).toBe('busy');

    const sending = send(h, 'Mention the risks.');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/steer'));
    expect(h.requests.find(([method]) => method === 'turn/steer')?.[1]).toMatchObject({ expectedTurnId: 'goal-turn-2' });
    h.burst([answer('goal-turn-2', 'Reply 2'), completed('goal-turn-2')]);

    await expect(sending).resolves.toBeUndefined();
    expect(h.completions).toEqual(['Working on it.', 'Reply 2']);
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
  });
});

describe('CodexCliAdapter sends that follow goal turns', () => {
  it('starts a fresh turn for a send after a chunk of goal turns, never steering a finished turn', async () => {
    const h = track(createHarness(userTurnRpc()));
    h.burst(goalTurns(GOAL_TURNS));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));

    const sending = send(h, 'What is left?');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/start'));
    h.burst([started('user-turn-1'), answer('user-turn-1', 'Nothing.'), completed('user-turn-1')]);

    await expect(sending).resolves.toBeUndefined();
    expect(methods(h)).not.toContain('turn/steer');
    expect(h.completions.at(-1)).toBe('Nothing.');
  });

  it('steers the turn Codex is running now, not an earlier turn of the chunk', async () => {
    const h = track(createHarness((method) => (method === 'turn/steer' ? { turnId: 'goal-turn-4' } : {})));
    h.burst([...goalTurns(3), started('goal-turn-4')]);
    await vi.waitFor(() => expect(h.currentTurnId()).toBe('goal-turn-4'));

    const sending = send(h, 'Also list the open risks.');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/steer'));
    expect(h.requests.filter(([method]) => method === 'turn/steer')).toEqual([
      ['turn/steer', expect.objectContaining({ threadId: THREAD, expectedTurnId: 'goal-turn-4' })],
    ]);

    h.burst([answer('goal-turn-4', 'Risks listed.'), completed('goal-turn-4')]);
    await expect(sending).resolves.toBeUndefined();
    expect(h.completions).toEqual([...replies(3), 'Risks listed.']);
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });

  it('keeps an accepted steer open past an early final answer, even after a chunk of goal turns', async () => {
    const h = track(createHarness((method) => (method === 'turn/steer' ? { turnId: 'goal-turn-4' } : {})));
    h.burst([...goalTurns(3), started('goal-turn-4')]);
    await vi.waitFor(() => expect(h.currentTurnId()).toBe('goal-turn-4'));

    const sending = send(h, 'Also list the open risks.');
    await vi.waitFor(() => expect(methods(h)).toContain('turn/steer'));
    await tick();
    h.emit(...answer('goal-turn-4', 'First paragraph.'));
    // Longer than the 250 ms after which a final answer alone would close the capture.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.currentTurnId()).toBe('goal-turn-4');
    expect(h.statuses.at(-1)).toBe('busy');

    h.emit(...completed('goal-turn-4'));
    await expect(sending).resolves.toBeUndefined();
    expect(h.completions).toEqual([...replies(3), 'First paragraph.']);
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
  });

  it('interrupts the turn Codex is running now and follows nothing afterwards', async () => {
    const h = track(createHarness());
    h.burst([...goalTurns(2), started('goal-turn-3')]);
    await vi.waitFor(() => expect(h.currentTurnId()).toBe('goal-turn-3'));

    const interrupt = h.adapter.interrupt();
    expect(interrupt).toMatchObject({ status: 'accepted', turnId: 'goal-turn-3' });
    await vi.waitFor(() => expect(h.requests).toContainEqual(['turn/interrupt', { threadId: THREAD, turnId: 'goal-turn-3' }]));
    h.emit(...completed('goal-turn-3', 'interrupted'));

    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.completions).toEqual(replies(2));
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.turnErrors).toEqual([]);
  });
});

describe('CodexCliAdapter ownership of goal continuation', () => {
  it('keeps native ownership while goal turns are followed and releases it once the goal completes', async () => {
    const h = track(createHarness());
    h.emit(...goalStatus('active'));
    h.burst([...goalTurns(2), started('goal-turn-3')]);

    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(true);
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(true);

    h.burst([answer('goal-turn-3', 'Reply 3'), completed('goal-turn-3')]);
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    // An active goal still owns the next turn even though none is running.
    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(true);

    h.emit(...goalStatus('complete'));
    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false);
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(false);
  });

  it('does not follow the Compact turn of a Harness compaction request that shares a chunk with goal turns', async () => {
    const compactionItem = { type: 'contextCompaction', id: 'compaction-item' };
    const h = track(createHarness((method) => {
      if (method === 'thread/compact/start') {
        setTimeout(() => h.burst([
          started('compact-turn'),
          ['item/started', { threadId: THREAD, turnId: 'compact-turn', item: compactionItem }],
          ['item/completed', { threadId: THREAD, turnId: 'compact-turn', item: compactionItem }],
          completed('compact-turn'),
        ]), 0);
      }
      return {};
    }));

    await expect(h.adapter.compactContext()).resolves.toBe(true);
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.completions).toEqual([]);

    h.burst(goalTurns(2));
    await vi.waitFor(() => expect(h.completions).toEqual(replies(2)));
  });
});

describe('CodexCliAdapter teardown while goal turns are followed', () => {
  it('releases stale publication ownership after the native thread is replaced', async () => {
    let release!: () => void;
    rolloutRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const h = track(createHarness(userTurnRpc()));
    h.burst(goalTurn(1));
    await tick();
    expect(h.hasActiveTurn()).toBe(false);
    h.replaceThread('replacement-thread');
    release();
    await tick();
    await tick();

    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false);
    expect(h.completions).toEqual([]);
    const sending = send(h, 'Continue here.');
    await eventually(() => expect(methods(h)).toContain('turn/start'));
    for (const [method, params] of [started('user-turn-1'), answer('user-turn-1', 'New thread reply.'), completed('user-turn-1')]) {
      h.emit(method, { ...params, threadId: 'replacement-thread' });
    }
    await expect(sending).resolves.toBeUndefined();
    expect(h.completions).toEqual(['New thread reply.']);
  });

  it('discards queued and in-flight replies from the terminated connection', async () => {
    let release!: () => void;
    rolloutRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const h = track(createHarness());
    h.burst(goalTurns(3));
    await tick();
    await h.adapter.terminate(false);
    const outputsAtExit = h.outputs.length;

    release();
    await tick();
    await tick();

    expect(h.completions).toEqual([]);
    expect(h.outputs).toHaveLength(outputsAtExit);
    h.revive();
    rolloutRead.gate = null;
    h.burst(goalTurn(5));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.completions).toEqual(['Reply 5']);
  });

  it('follows nothing and publishes no status once the adapter terminates mid-burst', async () => {
    const h = createHarness();
    h.burst([...goalTurn(1), started('goal-turn-2'), answer('goal-turn-2', 'Reply 2')]);
    const terminating = h.adapter.terminate(false);
    // Codex keeps writing while the adapter shuts down; none of it may start a capture.
    h.burst(goalTurn(3));
    await terminating;
    const settled = { statuses: h.statuses.length, outputs: h.outputs.length };
    h.burst(goalTurn(4));
    await tick();
    await tick();

    expect(h.hasActiveTurn()).toBe(false);
    expect(h.subscriberCount()).toBe(0);
    expect(h.statuses.filter((status) => status === 'busy')).toHaveLength(2);
    expect(h.statuses).toHaveLength(settled.statuses);
    expect(h.outputs).toHaveLength(settled.outputs);
    expect(h.turnErrors).toEqual([]);
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });

  it('carries no follow state into an adapter that is connected again after terminating', async () => {
    let release!: () => void;
    rolloutRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const h = track(createHarness());
    h.burst(goalTurns(2));
    await tick();
    await h.adapter.terminate(false);

    h.revive();
    // The old replies are still being published, but they belong to the terminated session.
    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false);
    h.burst(goalTurn(5));
    release();

    await vi.waitFor(() => expect(h.completions).toContain('Reply 5'));
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false);
    expect(h.hasActiveTurn()).toBe(false);
  });

  it('publishes no status or error when it terminates while replies are still being published', async () => {
    let release!: () => void;
    rolloutRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const h = createHarness();
    h.burst(goalTurns(3));
    await tick();

    await h.adapter.terminate(false);
    const settled = h.statuses.length;
    release();
    await tick();
    await tick();

    expect(h.statuses).toHaveLength(settled);
    expect(h.turnErrors).toEqual([]);
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });
});
