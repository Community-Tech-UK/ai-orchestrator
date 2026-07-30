/**
 * Runtime-change notices: the messages a session receives — and the user sees —
 * when its provider, model, thinking level or permission posture changes under
 * it mid-conversation.
 *
 * These are dual-purpose (LT-015). They are control messages the model needs in
 * order to reason correctly about what just happened to its runtime, *and* they
 * are the only signal the user gets that anything changed. Delivering them with
 * `adapter.sendInput` alone satisfies only the first: that call reaches the CLI
 * but never produces a visible transcript message, which is why every live check
 * asserting "the notice appears" failed against a working feature.
 *
 * Extracted from `runtime-reconciler.ts` to keep that file inside its LOC
 * budget, and so the notice wording is unit-testable without the reconciler.
 */

import { getLogger } from '../../logging/logger';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { Instance } from '../../../shared/types/instance.types';
import type { ReasoningEffort } from '../../../shared/types/provider.types';

const logger = getLogger('RuntimeChangeNotices');

/** Notice kinds, mirrored into each notice's transcript metadata. */
export type RuntimeChangeNoticeKind =
  | 'yolo-mode-changed'
  | 'provider-changed'
  | 'model-changed';

const PROVIDER_DEFAULT = 'provider default';

function effortLabel(effort: ReasoningEffort | null | undefined): string {
  return effort ?? PROVIDER_DEFAULT;
}

function modelLabel(model: string | undefined): string {
  return model || PROVIDER_DEFAULT;
}

/** Permission-posture change. */
export function yoloNoticeText(enabled: boolean): string {
  return enabled
    ? '[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]'
    : '[System: YOLO mode disabled - tool permissions will now require approval.]';
}

/** Cross-provider swap: context is carried over via replay, not resumed. */
export function providerChangeNoticeText(params: {
  oldProvider: string;
  oldModel: string | undefined;
  newProvider: string;
  newModel: string | undefined;
  oldReasoningEffort: ReasoningEffort | null | undefined;
  newReasoningEffort: ReasoningEffort | null | undefined;
}): string {
  return (
    `[System: Provider changed from ${params.oldProvider} (model ${modelLabel(params.oldModel)}) `
    + `to ${params.newProvider} (model ${modelLabel(params.newModel)}). `
    + `Thinking changed from ${effortLabel(params.oldReasoningEffort)} `
    + `to ${effortLabel(params.newReasoningEffort)}. `
    + 'Conversation context has been carried over from the previous provider.]'
  );
}

/** Same-provider model or thinking change: the conversation is preserved. */
export function modelChangeNoticeText(params: {
  oldModel: string | undefined;
  newModel: string | undefined;
  oldReasoningEffort: ReasoningEffort | null | undefined;
  newReasoningEffort: ReasoningEffort | null | undefined;
}): string {
  return (
    `[System: Model changed from ${modelLabel(params.oldModel)} `
    + `to ${modelLabel(params.newModel)}. `
    + `Thinking changed from ${effortLabel(params.oldReasoningEffort)} `
    + `to ${effortLabel(params.newReasoningEffort)}. `
    + 'Conversation context has been preserved.]'
  );
}

/** One notice to deliver and render. */
export interface RuntimeChangeNotice {
  text: string;
  kind: RuntimeChangeNoticeKind;
}

/**
 * Decide which notices a runtime change should announce, in order.
 *
 * A pure permission flip announces only that. Anything else announces the
 * provider/model change, plus a second permission notice when a queued model
 * swap and a queued YOLO flip happen to land in the same reconcile pass.
 */
export function runtimeChangeNoticesFor(params: {
  isYoloOnlyChange: boolean;
  isProviderSwap: boolean;
  yoloModeChanged: boolean;
  nextYoloMode: boolean;
  oldProvider: string;
  newProvider: string;
  oldModel: string | undefined;
  newModel: string | undefined;
  oldReasoningEffort: ReasoningEffort | null | undefined;
  newReasoningEffort: ReasoningEffort | null | undefined;
}): RuntimeChangeNotice[] {
  const yolo: RuntimeChangeNotice = {
    text: yoloNoticeText(params.nextYoloMode),
    kind: 'yolo-mode-changed',
  };
  if (params.isYoloOnlyChange) return [yolo];

  const primary: RuntimeChangeNotice = params.isProviderSwap
    ? { text: providerChangeNoticeText(params), kind: 'provider-changed' }
    : { text: modelChangeNoticeText(params), kind: 'model-changed' };

  return params.yoloModeChanged ? [primary, yolo] : [primary];
}

/**
 * Deliver a notice to the CLI **and** record it in the transcript.
 *
 * The transcript write is best-effort and deliberately runs *after* delivery:
 * the runtime change has already been applied to the live session by this point,
 * so failing to render a notice must never abort or reverse it. A failure is
 * logged rather than thrown.
 */
export async function announceRuntimeChange(params: {
  instance: Instance;
  adapter: CliAdapter;
  text: string;
  kind: RuntimeChangeNoticeKind;
  emitSystemNotice(
    instance: Instance,
    content: string,
    metadata?: Record<string, unknown>,
  ): void;
}): Promise<void> {
  await params.adapter.sendInput(params.text);
  try {
    params.emitSystemNotice(params.instance, params.text, { kind: params.kind });
  } catch (error) {
    logger.warn('Runtime-change notice delivered but not rendered', {
      instanceId: params.instance.id,
      kind: params.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
