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

import type { CliToolCall } from './base-cli-adapter.types';
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
