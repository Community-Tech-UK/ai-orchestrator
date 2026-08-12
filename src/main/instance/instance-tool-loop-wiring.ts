/**
 * WS-A2: result-aware tool-loop protection wiring for `InstanceManager`.
 *
 * `InstanceManager.emitProviderRuntimeEvent()` is the single funnel both
 * `InstanceCommunicationManager.setupAdapterEvents()` (via
 * `bindRawAdapterProviderEvents()`) and loop/worker event sources publish
 * through, so wiring the tool-loop detector there covers ordinary sessions
 * without touching `instance-communication.ts`. Detection is purely
 * additive: it emits typed 'tool-loop-detected' events (forwarded to the
 * renderer by `setupInstanceEventForwarding()`) and, only when
 * `toolLoopAutoInterrupt` is enabled, interrupts the turn on a 'critical'
 * detection. AIO cannot veto a tool call inside the CLI process — this is
 * the earliest point at which it can act on one.
 *
 * This module holds no state of its own; `InstanceManager` owns the
 * `ToolLoopWiringDeps` implementation (see `instance-manager.ts`) and calls
 * `observeToolLoopEvent()` from `emitProviderRuntimeEvent()`.
 *
 * LT-062: `bindRawAdapterProviderEvents()` only forwards a `tool_use`/
 * `tool_result` *kind* when an adapter emits the matching raw
 * `EventEmitter` event, and only `AcpCliAdapter` (Copilot/Cursor/Grok) ever
 * does. Claude/Codex/Gemini/Antigravity/Ollama surface tool activity as
 * `output` messages of `messageType: 'tool_use'`/`'tool_result'` instead
 * (`InstanceManager.publishOutput()` funnels every `OutputMessage` through
 * this same `emitProviderRuntimeEvent()` call as a `kind: 'output'` event
 * via `toProviderOutputEvent()`), so the detector never saw them. This
 * module now also bridges *that* shape — see `resolveToolLoopObservation`
 * below — gated on `metadata.transport !== 'acp'` so an ACP adapter's
 * `output` echo of the same call (it emits both) is never double-counted
 * alongside its raw event. Different adapters put the correlation id under
 * different metadata keys (or omit it entirely, e.g. Codex's command-item
 * `output` messages) and this bridge cannot invent one — a missing id still
 * counts toward `runaway` but fails open for the pairing detectors
 * (`repeat-no-progress`/`ping-pong`), exactly like a missing `argsHash`/
 * `resultHash` already does in `DoomLoopDetector`.
 */

import { getLogger } from '../logging/logger';
import {
  getDoomLoopDetector,
  type DoomLoopDetector,
  type ToolLoopDetectionEvent,
} from '../orchestration/doom-loop-detector';
import {
  toProviderToolUseObservedEvent,
  toProviderToolResultObservedEvent,
} from '../providers/adapter-runtime-event-bridge';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';

const logger = getLogger('InstanceToolLoopWiring');

/**
 * Minimal seam `InstanceManager` exposes to this wiring. Deliberately does
 * not capture bound copies of `interruptInstance`/setting lookups at
 * construction time — implementations should resolve `this.interruptInstance`
 * etc. at call time so test spies applied after construction are honoured.
 */
export interface ToolLoopWiringDeps {
  /** Current value of the `toolLoopAutoInterrupt` setting. */
  getAutoInterruptSetting(): unknown;
  /** Delegates to `InstanceManager.interruptInstance()`. */
  interruptInstance(instanceId: string): boolean;
}

/** WS-B10 normalizer, fed with only the fields available on a `ProviderToolUseEvent`. */
function toToolUseObservation(
  event: Extract<ProviderRuntimeEvent, { kind: 'tool_use' }>,
): { toolName: string; callId?: string; argsHash?: string } {
  const shape: Record<string, unknown> = { name: event.toolName };
  if (event.toolUseId !== undefined) shape['id'] = event.toolUseId;
  if (event.input !== undefined) shape['arguments'] = event.input;
  const observed = toProviderToolUseObservedEvent(shape as unknown as CliToolCall);
  return { toolName: event.toolName, callId: observed.callId, argsHash: observed.argsHash };
}

/** WS-B10 normalizer, fed with only the fields available on a `ProviderToolResultEvent`. */
function toToolResultObservation(
  event: Extract<ProviderRuntimeEvent, { kind: 'tool_result' }>,
): { callId?: string; resultHash?: string; isError?: boolean } {
  const shape: Record<string, unknown> = { name: event.toolName };
  if (event.toolUseId !== undefined) shape['id'] = event.toolUseId;
  if (event.output !== undefined) shape['result'] = event.output;
  const observed = toProviderToolResultObservedEvent(shape as unknown as CliToolCall);
  return { callId: observed.callId, resultHash: observed.resultHash, isError: event.success === false };
}

/**
 * LT-062: metadata key names different adapters use for a tool call's
 * correlation id on an `OutputMessage`, tried in this priority order. ACP
 * uses `toolCallId`; Claude's content-block `tool_use` metadata is a bare
 * `{ name, id, input }`; its legacy top-level `tool_result` message uses
 * `tool_use_id`. Codex's real-time `tool_use`/`tool_result` items carry no
 * id at all (see module doc) — that is a genuine gap, not a bug here.
 */
const OUTPUT_TOOL_CALL_ID_KEYS = ['id', 'toolCallId', 'tool_use_id', 'toolUseId'] as const;

function readOutputMetadataId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  for (const key of OUTPUT_TOOL_CALL_ID_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function readOutputMetadataToolName(metadata: Record<string, unknown> | undefined): string | undefined {
  const name = metadata?.['name'] ?? metadata?.['toolName'];
  return typeof name === 'string' && name ? name : undefined;
}

function readOutputMetadataArgs(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const args = metadata?.['input'] ?? metadata?.['arguments'];
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function readOutputMetadataIsError(metadata: Record<string, unknown> | undefined): boolean | undefined {
  const isError = metadata?.['is_error'] ?? metadata?.['isError'];
  return typeof isError === 'boolean' ? isError : undefined;
}

/** LT-062 bridge: normalize a `tool_use`-typed `output` message into the same observation shape as a raw `tool_use` event. */
function toToolUseObservationFromOutput(
  metadata: Record<string, unknown> | undefined,
): { toolName: string; callId?: string; argsHash?: string } {
  const toolName = readOutputMetadataToolName(metadata) ?? 'unknown';
  const callId = readOutputMetadataId(metadata);
  const toolCall: CliToolCall = { id: callId ?? '', name: toolName, arguments: readOutputMetadataArgs(metadata) };
  const observed = toProviderToolUseObservedEvent(toolCall);
  return { toolName, callId, argsHash: observed.argsHash };
}

/** LT-062 bridge: normalize a `tool_result`-typed `output` message into the same observation shape as a raw `tool_result` event. */
function toToolResultObservationFromOutput(
  content: string,
  metadata: Record<string, unknown> | undefined,
): { callId?: string; resultHash?: string; isError?: boolean } {
  const callId = readOutputMetadataId(metadata);
  const toolCall: CliToolCall = {
    id: callId ?? '',
    name: readOutputMetadataToolName(metadata) ?? 'unknown',
    arguments: {},
    result: content,
  };
  const observed = toProviderToolResultObservedEvent(toolCall);
  return { callId, resultHash: observed.resultHash, isError: readOutputMetadataIsError(metadata) };
}

function maybeAutoInterruptOnToolLoop(
  deps: ToolLoopWiringDeps,
  detector: DoomLoopDetector,
  instanceId: string,
  detection: ToolLoopDetectionEvent,
): void {
  if (detection.severity !== 'critical') return;
  if (deps.getAutoInterruptSetting() !== true) return;
  if (detector.hasAutoInterruptedThisTurn(instanceId)) return;

  detector.markAutoInterrupted(instanceId);
  logger.warn('Auto-interrupting instance after critical tool loop', {
    instanceId,
    detector: detection.detector,
    toolName: detection.toolName,
    count: detection.count,
    windowDescription: detection.windowDescription,
  });

  try {
    deps.interruptInstance(instanceId);
  } catch (err) {
    logger.warn('Auto-interrupt after critical tool loop failed', {
      instanceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type ResolvedToolLoopObservation =
  | { kind: 'tool_use'; data: { toolName: string; callId?: string; argsHash?: string } }
  | { kind: 'tool_result'; data: { callId?: string; resultHash?: string; isError?: boolean } };

/**
 * Resolve a `ProviderRuntimeEvent` into a tool-loop observation, or `null`
 * if it isn't tool-call-shaped. Handles both the raw `tool_use`/`tool_result`
 * kinds (today: only `AcpCliAdapter`) and the LT-062 bridge from an `output`
 * message whose `messageType` is `'tool_use'`/`'tool_result'` (every other
 * built-in adapter). `metadata.transport === 'acp'` is excluded from the
 * bridge because `AcpCliAdapter` already emits a raw event for the same
 * call (see module doc) — without this check that call would be observed
 * twice.
 */
function resolveToolLoopObservation(event: ProviderRuntimeEvent): ResolvedToolLoopObservation | null {
  if (event.kind === 'tool_use') return { kind: 'tool_use', data: toToolUseObservation(event) };
  if (event.kind === 'tool_result') return { kind: 'tool_result', data: toToolResultObservation(event) };
  if (event.kind !== 'output') return null;
  if (event.messageType !== 'tool_use' && event.messageType !== 'tool_result') return null;
  if (event.metadata?.['transport'] === 'acp') return null;

  return event.messageType === 'tool_use'
    ? { kind: 'tool_use', data: toToolUseObservationFromOutput(event.metadata) }
    : { kind: 'tool_result', data: toToolResultObservationFromOutput(event.content, event.metadata) };
}

/**
 * Feed a normalized tool_use/tool_result observation through the
 * result-aware tool-loop detector, auto-interrupting when a critical
 * detection fires and `toolLoopAutoInterrupt` is enabled. Non tool-call
 * events and detection/interrupt failures are no-ops (fail-open — see
 * module doc on `../orchestration/doom-loop-detector.ts`).
 */
export function observeToolLoopEvent(
  deps: ToolLoopWiringDeps,
  instanceId: string,
  event: ProviderRuntimeEvent,
): void {
  const observation = resolveToolLoopObservation(event);
  if (!observation) return;

  try {
    const detector = getDoomLoopDetector();
    const detections: ToolLoopDetectionEvent[] = observation.kind === 'tool_use'
      ? detector.recordToolUse(instanceId, observation.data)
      : detector.recordToolResult(instanceId, observation.data);

    for (const detection of detections) {
      maybeAutoInterruptOnToolLoop(deps, detector, instanceId, detection);
    }
  } catch (err) {
    logger.warn('Tool loop observation failed', {
      instanceId,
      eventKind: event.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
