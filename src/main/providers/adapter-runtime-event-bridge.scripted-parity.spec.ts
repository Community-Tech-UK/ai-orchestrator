/**
 * Parity / integration spec: the {@link ScriptedCliAdapter} (A6 deterministic
 * test harness) driven through the PRODUCTION runtime-event bridge
 * ({@link observeAdapterRuntimeEvents}).
 *
 * The sibling `adapter-runtime-event-bridge.spec.ts` exercises the bridge with a
 * raw `EventEmitter` emitting hand-crafted payloads. That proves the *bridge*
 * normalizes correctly, but nothing proves the scripted harness — when actually
 * *played* via `sendMessage`/`sendMessageStream` — emits the event vocabulary the
 * bridge expects. This spec closes that gap: it composes both halves the way a
 * real consumer (coordinator / loop supervisor / instance lifecycle) would, and
 * synchronises on the turn lifecycle (`drainRuntime`) and recorded receipts
 * (`awaitReceipt`) instead of sleeping.
 *
 * This is the worked example + regression guard the A6 harness promised: replay a
 * provider-neutral parity fixture and assert the normalized downstream events are
 * identical regardless of which real provider would have produced the turn.
 */

import { describe, expect, it } from 'vitest';
import {
  observeAdapterRuntimeEvents,
  type NormalizedAdapterRuntimeEvent,
} from './adapter-runtime-event-bridge';
import { ScriptedCliAdapter } from '../cli/adapters/scripted-cli-adapter';
import {
  awaitReceipt,
  byType,
  drainRuntime,
  errorTurn,
  multiChunkTurn,
  simpleTextTurn,
  tokenPacedTurn,
  toolUseTurn,
} from '../cli/adapters/scripted-cli-adapter.test-helpers';
import type { CliMessage } from '../cli/adapters/base-cli-adapter.types';

const userMessage: CliMessage = { role: 'user', content: 'hi' };

/** Attach the production bridge to a scripted adapter and collect normalized events. */
function observe(adapter: ScriptedCliAdapter): {
  events: NormalizedAdapterRuntimeEvent[];
  cleanup: () => void;
} {
  const events: NormalizedAdapterRuntimeEvent[] = [];
  const cleanup = observeAdapterRuntimeEvents(adapter, (event) => events.push(event));
  return { events, cleanup };
}

const kinds = (events: NormalizedAdapterRuntimeEvent[]): string[] =>
  events.map(({ event }) => event.kind);

describe('ScriptedCliAdapter → adapter-runtime-event-bridge (parity)', () => {
  it('plays a simple text turn into spawned/output/complete provider events', async () => {
    const adapter = new ScriptedCliAdapter();
    const { events } = observe(adapter);

    adapter.enqueueTurn(simpleTextTurn('Hello world'));
    await adapter.sendMessage(userMessage);
    await drainRuntime(adapter);

    expect(kinds(events)).toEqual(['spawned', 'output', 'complete']);
    expect(events[0]?.event).toEqual({ kind: 'spawned', pid: 424242 });
    expect(events[1]?.event).toMatchObject({
      kind: 'output',
      content: 'Hello world',
      messageType: 'assistant',
    });
    // `defaultUsage` (~4 chars/token) flows through to the runtime `complete` event.
    expect(events[2]?.event).toMatchObject({ kind: 'complete' });
    const complete = events[2]?.event as { kind: 'complete'; tokensUsed?: number };
    expect(complete.tokensUsed).toBeGreaterThan(0);
  });

  it('bridges scripted token pacing, cache usage, cost, and quota diagnostics', async () => {
    const adapter = new ScriptedCliAdapter();
    const { events } = observe(adapter);
    const resetAt = Date.now() + 60_000;

    adapter.enqueueTurn(tokenPacedTurn('cached answer', {
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      reasoningTokens: 50,
      cost: 0.0123,
      contextWindowTokens: 200_000,
      contextSteps: 2,
      metadata: {
        quota: {
          exhausted: false,
          resetAt,
          message: '5-hour window has headroom',
        },
      },
    }));
    await adapter.sendMessage(userMessage);
    await drainRuntime(adapter);

    expect(kinds(events)).toEqual(['spawned', 'context', 'context', 'output', 'complete']);
    expect(events.filter((event) => event.kind === 'context').map((event) => {
      const context = event.event as { used: number; total: number; percentage: number };
      return { used: context.used, total: context.total, percentage: context.percentage };
    })).toEqual([
      { used: 775, total: 200_000, percentage: 0.3875 },
      { used: 1550, total: 200_000, percentage: 0.775 },
    ]);

    const complete = events.at(-1);
    expect(complete?.event).toMatchObject({
      kind: 'complete',
      tokensUsed: 1550,
      costUsd: 0.0123,
      quota: {
        exhausted: false,
        resetAt,
        message: '5-hour window has headroom',
      },
    });
    expect((complete?.rawPayload as { usage?: { cacheReadTokens?: number; cacheWriteTokens?: number } }).usage)
      .toMatchObject({ cacheReadTokens: 400, cacheWriteTokens: 100 });
  });

  it('plays a tool-use turn into the full status/tool_use/tool_result sequence', async () => {
    const adapter = new ScriptedCliAdapter();
    const { events } = observe(adapter);

    adapter.enqueueTurn(toolUseTurn());
    await adapter.sendMessage(userMessage);
    await drainRuntime(adapter);

    expect(kinds(events)).toEqual([
      'spawned',
      'status',
      'tool_use',
      'tool_result',
      'output',
      'complete',
    ]);
    expect(events[1]?.event).toEqual({ kind: 'status', status: 'working' });
    expect(events[2]?.event).toEqual({
      kind: 'tool_use',
      toolName: 'Read',
      toolUseId: 'tool-1',
      input: { path: '/tmp/example.ts' },
    });
    expect(events[3]?.event).toEqual({
      kind: 'tool_result',
      toolName: 'Read',
      toolUseId: 'tool-1',
      success: true,
      output: 'file contents',
    });
  });

  it('bridges a streaming turn (sendMessageStream) without sleeps', async () => {
    const adapter = new ScriptedCliAdapter();
    const { events } = observe(adapter);

    adapter.enqueueTurn(multiChunkTurn(['a', 'b', 'c']));
    const chunks: string[] = [];
    for await (const chunk of adapter.sendMessageStream(userMessage)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['a', 'b', 'c']);
    expect(kinds(events)).toEqual(['spawned', 'output', 'output', 'output', 'complete']);
    expect(
      events
        .filter((e) => e.event.kind === 'output')
        .map((e) => (e.event as { content: string }).content),
    ).toEqual(['a', 'b', 'c']);
  });

  it('bridges a non-fatal error step into a recoverable=false error event', async () => {
    const adapter = new ScriptedCliAdapter();
    const { events } = observe(adapter);

    // The bridge attaches an `error` listener, so the scripted adapter (which
    // only emits `error` when one is present) surfaces it through the bridge.
    adapter.enqueueTurn(errorTurn('scripted failure'));
    await adapter.sendMessage(userMessage);
    await drainRuntime(adapter);

    expect(kinds(events)).toEqual(['spawned', 'error', 'complete']);
    expect(events[1]?.event).toMatchObject({
      kind: 'error',
      message: 'scripted failure',
      recoverable: false,
    });
  });

  it('bridges terminate() into an exit event and synchronises via the receipt bus', async () => {
    const adapter = new ScriptedCliAdapter();
    const { events } = observe(adapter);

    adapter.enqueueTurn(simpleTextTurn('bye'));
    await adapter.sendMessage(userMessage);
    await adapter.terminate();
    // Synchronise on the recorded exit receipt rather than a wall-clock sleep.
    await awaitReceipt(adapter.receipts, byType('exit'));

    expect(kinds(events)).toContain('exit');
    expect(events.at(-1)?.event).toEqual({ kind: 'exit', code: 0, signal: null });
  });

  it('produces identical downstream events for the same fixture across adapters (determinism)', async () => {
    const runFixture = async (): Promise<NormalizedAdapterRuntimeEvent[]> => {
      const adapter = new ScriptedCliAdapter();
      const { events } = observe(adapter);
      adapter.enqueueTurn(toolUseTurn());
      await adapter.sendMessage(userMessage);
      await drainRuntime(adapter);
      return events;
    };

    const first = await runFixture();
    const second = await runFixture();

    // The provider-neutral `event` projection is deterministic once the
    // per-run identifiers the bridge mints for string outputs (`messageId`,
    // wall-clock `timestamp`) are stripped — everything else (kinds, ordering,
    // tool names/ids/inputs, token counts) must match across providers/runs.
    const stable = (events: NormalizedAdapterRuntimeEvent[]): unknown[] =>
      events.map(({ event }) => {
        const rest = { ...event } as Record<string, unknown>;
        delete rest['messageId'];
        delete rest['timestamp'];
        return rest;
      });

    expect(stable(second)).toEqual(stable(first));
  });
});
