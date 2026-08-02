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

/** How long to wait for the CLI to accept a notice before giving up on it. */
const NOTICE_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Send to the CLI, but never wait forever (LT-030).
 *
 * Every post-swap `adapter.sendInput` shares one hazard: on a loop-bearing
 * session the loop reclaims the adapter for its next iteration the moment the
 * swap lands, and the send never settles. Anything awaiting it becomes dead
 * code — which is how a provider swap on a looping session silently produced no
 * notices at all and left `applyRuntimeChange` unresolved.
 *
 * A genuine rejection still propagates; only slowness is absorbed.
 */
export async function sendInputWithoutWedging(
  adapter: Pick<CliAdapter, 'sendInput'>,
  text: string,
  context: { instanceId: string; what: string },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      adapter.sendInput(text),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn('CLI did not accept a post-change message in time; continuing', {
            instanceId: context.instanceId,
            what: context.what,
            timeoutMs: NOTICE_DELIVERY_TIMEOUT_MS,
          });
          resolve();
        }, NOTICE_DELIVERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Announce a completed runtime change: every applicable notice, then the
 * loop-provider divergence line if this session now disagrees with a loop
 * running on it (LT-020).
 *
 * Lives here rather than in the reconciler so the ordering rules above — render
 * first, deliver bounded — apply to the whole sequence in one place.
 */
export async function announceRuntimeChangeSet(params: {
  instance: Instance;
  adapter: CliAdapter;
  notices: RuntimeChangeNotice[];
  emitSystemNotice(
    instance: Instance,
    content: string,
    metadata?: Record<string, unknown>,
  ): void;
  divergence?: string | null;
  /**
   * Extra control text to deliver in the SAME message as the notices — the
   * replay-continuity preamble on a non-resuming change.
   *
   * It must ride along rather than be sent separately (LT-030). On Codex,
   * `sendInput` starts a real model turn, so a second send lands on a runtime
   * that "already has an active turn" and is refused — and the reconciler
   * treated that as a failed change and reverted a swap it had already applied.
   * This was the root cause: the colliding sends were the reconciler's OWN, not
   * the loop's.
   */
  preamble?: string;
}): Promise<void> {
  // Render first, always — this is the half the user sees, and it must not
  // depend on a CLI that may be slow, busy, or gone.
  for (const notice of params.notices) {
    try {
      params.emitSystemNotice(params.instance, notice.text, { kind: notice.kind });
    } catch (error) {
      logger.warn('Runtime-change notice could not be rendered', {
        instanceId: params.instance.id,
        kind: notice.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (params.divergence) {
    try {
      params.emitSystemNotice(params.instance, params.divergence, {
        kind: 'loop-provider-divergence',
      });
    } catch (error) {
      // Same reasoning as the notices above: `emitSystemNotice` runs buffer,
      // streaming and persistence work plus arbitrary `output` listeners, and a
      // throw here would propagate into the reconciler's catch and revert a swap
      // that has already been applied and persisted.
      logger.warn('Loop-divergence notice could not be rendered', {
        instanceId: params.instance.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Then ONE delivery for the whole set — see `preamble` for why it cannot be
  // several.
  const body = [params.preamble, ...params.notices.map((n) => n.text)]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n\n');
  if (!body) return;
  try {
    await sendInputWithoutWedging(params.adapter, body, {
      instanceId: params.instance.id,
      what: 'runtime-change-announcement',
    });
  } catch (error) {
    // Best-effort by construction. The runtime change is already applied AND
    // its identity written through by the time we get here, so a refused send
    // — e.g. a provider whose runtime "already has an active turn" — must not
    // propagate and make the caller revert it. The user has the transcript
    // entries either way; only the model's copy is missing.
    logger.warn('Runtime-change announcement rendered but not delivered', {
      instanceId: params.instance.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
