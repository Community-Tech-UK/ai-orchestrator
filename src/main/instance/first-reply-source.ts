/**
 * Waits for the assistant's first reply in a session, for naming a session
 * whose opening message points at a pasted picture and names nothing else.
 */
import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import { isProviderNotice } from '../cli/provider-notice';
import { detectAuthFailureSignal } from './instance-auth-failure-detection';

export interface FirstReplyInstanceSource {
  getInstance(instanceId: string): Pick<Instance, 'status' | 'isRenamed' | 'outputBuffer'> | undefined;
}

/** Enough reply text to say what the picture shows; a title prompt uses at most 1,000. */
const ENOUGH_REPLY_CHARS = 300;
/**
 * The longest the wait for a reply lasts. A long first turn must not rename
 * the session after the user has been looking at it for an hour.
 */
const REPLY_WAIT_MS = 5 * 60_000;
const REPLY_POLL_MS = 1_000;

/** The first turn is over: no more reply is coming for now. */
const TURN_OVER = new Set<InstanceStatus>(['idle', 'ready', 'waiting_for_input']);
/** The session ended or was put away; nothing more is coming. */
const SESSION_GONE = new Set<InstanceStatus>(['error', 'failed', 'terminated', 'cancelled',
  'superseded', 'hibernating', 'hibernated']);

/**
 * A usage-limit notice or sign-in banner arrives as assistant text but says
 * nothing about the picture; naming from it gives "Claude session limit". Such
 * notices are short, so a long reply that mentions a limit or a login still counts.
 */
const NOTICE_MAX_CHARS = 400;

function isProviderStatusText(text: string): boolean {
  return text.length <= NOTICE_MAX_CHARS && (isProviderNotice(text) || detectAuthFailureSignal(text) !== null);
}

/**
 * Assistant text so far, leaving out replies copied in before the wait began
 * (a forked session's history) and provider status notices.
 */
function assistantText(outputBuffer: Instance['outputBuffer'], earlier: ReadonlySet<string>): string {
  return outputBuffer
    .filter((message) => message.type === 'assistant' && !earlier.has(message.id))
    .map((message) => message.content.trim())
    .filter((text) => text && !isProviderStatusText(text))
    .join('\n');
}

/**
 * Resolves with the assistant's reply once it is long enough, the first turn
 * ends, or the wait runs out. Only replies that arrive after the call count.
 * Resolves null when there is no reply by then, the session ends, or the user
 * renames it.
 */
export async function awaitFirstReply(
  source: FirstReplyInstanceSource,
  instanceId: string,
): Promise<string | null> {
  const deadline = Date.now() + REPLY_WAIT_MS;
  const earlier = new Set<string>((source.getInstance(instanceId)?.outputBuffer ?? [])
    .filter((message) => message.type === 'assistant').map((message) => message.id));
  for (;;) {
    const instance = source.getInstance(instanceId);
    if (!instance || instance.isRenamed || SESSION_GONE.has(instance.status)) return null;
    const reply = assistantText(instance.outputBuffer, earlier);
    if (reply.length >= ENOUGH_REPLY_CHARS || (reply && TURN_OVER.has(instance.status))) return reply;
    if (Date.now() >= deadline) return reply || null;
    await new Promise<void>((resolve) => { setTimeout(resolve, REPLY_POLL_MS).unref?.(); });
  }
}
