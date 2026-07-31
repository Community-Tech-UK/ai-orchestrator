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

/**
 * Feed a normalized tool_use/tool_result event through the result-aware
 * tool-loop detector, auto-interrupting when a critical detection fires and
 * `toolLoopAutoInterrupt` is enabled. Non tool_use/tool_result events and
 * detection/interrupt failures are no-ops (fail-open — see module doc on
 * `../orchestration/doom-loop-detector.ts`).
 */
export function observeToolLoopEvent(
  deps: ToolLoopWiringDeps,
  instanceId: string,
  event: ProviderRuntimeEvent,
): void {
  if (event.kind !== 'tool_use' && event.kind !== 'tool_result') return;

  try {
    const detector = getDoomLoopDetector();
    const detections: ToolLoopDetectionEvent[] = event.kind === 'tool_use'
      ? detector.recordToolUse(instanceId, toToolUseObservation(event))
      : detector.recordToolResult(instanceId, toToolResultObservation(event));

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
