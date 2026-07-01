/**
 * Test helpers + parity fixtures for {@link ScriptedCliAdapter}.
 *
 * `drainRuntime` and `awaitReceipt` replace `await sleep(...)` in adapter tests:
 * synchronise on the actual turn lifecycle / recorded receipts instead of guessed
 * wall-clock delays.
 *
 * The "parity fixtures" are canonical, provider-neutral turn shapes (plain text,
 * tool-use, multi-chunk, error). Replaying the same fixture through the scripted
 * adapter lets a test assert a downstream consumer behaves identically regardless
 * of which real provider would have produced the turn.
 */

import type { CliToolCall, CliUsage } from './base-cli-adapter.types';
import type { ReceiptBus, ReceiptPredicate, Receipt, AwaitReceiptOptions } from './receipt-bus';
import type { ScriptedCliAdapter, ScriptStep } from './scripted-cli-adapter';

/** Resolve once the adapter's in-flight scripted turn has finished playing. */
export function drainRuntime(adapter: ScriptedCliAdapter): Promise<void> {
  return adapter.drain();
}

/** Resolve once a receipt matching `predicate` has been recorded on `bus`. */
export function awaitReceipt(
  bus: ReceiptBus,
  predicate: ReceiptPredicate,
  opts?: AwaitReceiptOptions,
): Promise<Receipt> {
  return bus.awaitReceipt(predicate, opts);
}

/** Predicate builder: match the first receipt of a given event type. */
export function byType(type: Receipt['type']): ReceiptPredicate {
  return (r) => r.type === type;
}

// ---- parity fixtures -------------------------------------------------------

/** A plain assistant text turn: stream one chunk, then complete. */
export function simpleTextTurn(text = 'Hello from the scripted adapter.'): ScriptStep[] {
  return [
    { kind: 'output', content: text },
    { kind: 'complete', response: { content: text } },
  ];
}

/** A multi-chunk text turn: several `output` events before completion. */
export function multiChunkTurn(chunks: string[] = ['Thinking… ', 'here is ', 'the answer.']): ScriptStep[] {
  return [
    ...chunks.map((content): ScriptStep => ({ kind: 'output', content })),
    { kind: 'complete', response: { content: chunks.join('') } },
  ];
}

export interface TokenPacedTurnOptions extends CliUsage {
  readonly contextWindowTokens: number;
  readonly contextSteps?: number;
  readonly contextSource?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * A deterministic usage fixture for cost/quota tests: emits optional context
 * pacing, then output, then a complete response with exact provider usage.
 */
export function tokenPacedTurn(content: string, options: TokenPacedTurnOptions): ScriptStep[] {
  const usage = tokenPacedUsage(options);
  const totalTokens = usage.totalTokens ?? 0;
  const contextSteps = Math.max(0, Math.floor(options.contextSteps ?? 0));
  const contextWindowTokens = Math.max(1, options.contextWindowTokens);
  const steps: ScriptStep[] = [];

  for (let index = 1; index <= contextSteps; index += 1) {
    const used = Math.round((totalTokens * index) / contextSteps);
    steps.push({
      kind: 'context',
      usage: {
        used,
        total: contextWindowTokens,
        percentage: (used / contextWindowTokens) * 100,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cumulativeTokens: used,
        ...(options.contextSource ? { source: options.contextSource } : {}),
      },
    });
  }

  steps.push({ kind: 'output', content });
  steps.push({
    kind: 'complete',
    response: {
      content,
      usage,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
  });
  return steps;
}

function tokenPacedUsage(options: TokenPacedTurnOptions): CliUsage {
  const totalTokens = options.totalTokens ?? sumDefined(
    options.inputTokens,
    options.outputTokens,
    options.cacheReadTokens,
    options.cacheWriteTokens,
    options.reasoningTokens,
  );
  return {
    ...(options.inputTokens !== undefined ? { inputTokens: options.inputTokens } : {}),
    ...(options.outputTokens !== undefined ? { outputTokens: options.outputTokens } : {}),
    ...(options.cacheReadTokens !== undefined ? { cacheReadTokens: options.cacheReadTokens } : {}),
    ...(options.cacheWriteTokens !== undefined ? { cacheWriteTokens: options.cacheWriteTokens } : {}),
    ...(options.reasoningTokens !== undefined ? { reasoningTokens: options.reasoningTokens } : {}),
    totalTokens,
    ...(options.cost !== undefined ? { cost: options.cost } : {}),
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
  };
}

function sumDefined(...values: (number | undefined)[]): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** A tool-use turn: status → tool_use → tool_result → final text → complete. */
export function toolUseTurn(
  toolCall: CliToolCall = {
    id: 'tool-1',
    name: 'Read',
    arguments: { path: '/tmp/example.ts' },
    result: 'file contents',
  },
  finalText = 'Done reading the file.',
): ScriptStep[] {
  const { result, ...invocation } = toolCall;
  return [
    { kind: 'status', status: 'working' },
    { kind: 'tool_use', toolCall: invocation },
    { kind: 'tool_result', toolCall: { ...invocation, result: result ?? '' } },
    { kind: 'output', content: finalText },
    { kind: 'complete', response: { content: finalText, toolCalls: [toolCall] } },
  ];
}

/** An error turn: emit an `error` event. Set `fail` to also reject the turn. */
export function errorTurn(message = 'scripted failure', fail = false): ScriptStep[] {
  return [{ kind: 'error', error: message, fail }];
}
