import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import { sessionKindOf } from '../../shared/types/session-kind.types';
import { machineSessionReasonOf } from '../../shared/utils/machine-session';
import { memberProfileIdOf } from '../../shared/utils/mobile-profile-stamp';
import { isProviderNotice } from '../cli/provider-notice';
import { detectWaitingOnWork } from '../orchestration/waiting-on-work-detector';
import { isOperatorSession } from '../mobile-gateway/mobile-gateway-session-visibility';
import type { WatcherLevel } from './watcher-post-checks';

/** The only provider whose cheap model met the watcher's safety marks (plan history, 15 November 2026). */
export const WATCHER_JUDGED_PROVIDER = 'claude';

/** What the gates need to know about the rest of the app. Every answer is synchronous and cheap. */
export interface WatcherGateDeps {
  /** The `keepSessionsGoing` setting; `off` switches the watcher off. */
  level(): WatcherLevel | 'off';
  isLoopChat(instanceId: string): boolean;
  isSideChat(instance: Instance): boolean;
  isPaused(instanceId: string): boolean;
  /** Tracked background work that will wake the session by itself. */
  hasInhibitor(instanceId: string): boolean;
  /** A request to the user that Harness already shows (question card, browser approval, document review). */
  hasOpenRequest(instance: Instance): boolean;
  /** Another automatic reply is already queued for this session. */
  hasPendingContinuation(instanceId: string): boolean;
}

const READY = new Set<Instance['status']>(['idle', 'ready', 'busy']);
const ASLEEP = new Set<Instance['status']>(['hibernating', 'hibernated', 'waking']);
const RUNNING_CHILD = new Set<Instance['status']>(['busy', 'initializing', 'waiting_for_input', 'waiting_for_permission', 'respawning', 'waking']);

/** Placeholder replies a CLI prints instead of a model turn. Short, anchored, linear. */
const ERROR_NOTICE_PATTERNS: readonly RegExp[] = [
  /^API Error\b/i,
  /^No response requested\.?$/i,
  /^Failed to authenticate\b/i,
  /^(?:Invalid API key|Credit balance is too low|Prompt is too long)\b/i,
  /^Claude AI usage limit reached\b/i,
];
const ERROR_NOTICE_MAX_CHARS = 600;

/** True when the reply is an error, usage-limit or placeholder notice, not something the agent wrote. */
export function isErrorNotice(finalReply: string, model?: string): boolean {
  const text = finalReply.trim();
  if (model === '<synthetic>') return true;
  if (!text || text.length > ERROR_NOTICE_MAX_CHARS) return false;
  return isProviderNotice(text) || ERROR_NOTICE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Is this a session the watcher looks after at all? The user's own top-level
 * chat sessions, with the setting on and the session not muted. Helper agents,
 * loops, Plan Queue jobs, automations, reviews, side chats and a phone member's
 * sessions have their own drivers. The notice senders ask the same question.
 */
export function watcherCoversSession(instance: Instance, deps: Pick<WatcherGateDeps, 'level' | 'isLoopChat' | 'isSideChat'>): boolean {
  if (deps.level() === 'off' || instance.watcherMuted === true) return false;
  if (instance.parentId !== null || instance.launchMode !== 'orchestrated') return false;
  if (sessionKindOf(machineSessionReasonOf(instance)) !== 'chat' || !isOperatorSession(instance)) return false;
  if (memberProfileIdOf(instance.metadata) !== undefined) return false;
  if (instance.provider !== WATCHER_JUDGED_PROVIDER) return false;
  return !deps.isLoopChat(instance.id) && !deps.isSideChat(instance);
}

/** Why this finished turn is not judged, or null when it is. Only called for a session the watcher covers. */
export function watcherTurnSkipReason(
  envelope: ProviderRuntimeEventEnvelope,
  instance: Instance,
  deps: WatcherGateDeps,
  getInstance: (instanceId: string) => Instance | undefined,
): string | null {
  const { event } = envelope;
  if (event.kind !== 'complete') return 'not-a-completion';
  if (event.turnEnding?.reason !== undefined && event.turnEnding.reason !== 'completed') return `ended-${event.turnEnding.reason}`;
  if (event.turnEnding?.autoContinueSuppressed === true) return 'auto-continue-suppressed';
  if (event.degradedReason !== undefined) return 'degraded';
  if (event.quota?.exhausted === true || event.rateLimit?.remaining === 0) return 'quota';
  if (event.requestCountAtCompletion === undefined || event.requestCountAtCompletion !== instance.requestCount) return 'stale-completion';
  if (instance.lastTurnOutcome !== undefined && instance.lastTurnOutcome !== 'completed') return `turn-${instance.lastTurnOutcome}`;
  return watcherStateSkipReason(instance, deps, getInstance);
}

/** The part of the turn check that can change while the judge runs; asked again before acting. */
export function watcherStateSkipReason(
  instance: Instance,
  deps: WatcherGateDeps,
  getInstance: (instanceId: string) => Instance | undefined,
): string | null {
  if (ASLEEP.has(instance.status)) return 'asleep';
  if (!READY.has(instance.status)) return `status-${instance.status}`;
  if (instance.waitReason !== undefined) return `waiting-${instance.waitReason.kind}`;
  if (instance.planMode.state === 'planning') return 'plan-mode';
  if (deps.isPaused(instance.id)) return 'paused';
  if (deps.hasInhibitor(instance.id)) return 'background-work';
  if (instance.childrenIds.some((id) => RUNNING_CHILD.has(getInstance(id)?.status as Instance['status']))) return 'helpers-running';
  if (deps.hasOpenRequest(instance)) return 'open-request';
  if (deps.hasPendingContinuation(instance.id)) return 'continuation-queued';
  return null;
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * True when every word of the reply sits inside fenced code blocks: a copy box (a translation or draft to send,
 * a command) with nothing said to the user, so it cannot be asking them anything. Linear, line by line.
 */
export function isOnlyFencedText(reply: string): boolean {
  let fence: string | null = null;
  let sawBlock = false;
  for (const line of reply.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker) { fence = marker; sawBlock = true; } else if (/[\p{L}\p{N}]/u.test(line)) return false;
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    }
  }
  return sawBlock;
}

/** Why the final reply itself is not judged, or null. Needs the built brief, so it runs after the cheap gates. */
export function watcherReplySkipReason(finalReply: string, typedMessages: number, model?: string): string | null {
  if (typedMessages === 0) return 'no-typed-message';
  if (!finalReply.trim()) return 'no-reply';
  if (isErrorNotice(finalReply, model)) return 'error-notice';
  if (detectWaitingOnWork(finalReply)) return 'waiting-on-work';
  if (isOnlyFencedText(finalReply)) return 'only-copy-box';
  return null;
}
