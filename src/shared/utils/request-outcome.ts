/**
 * Plain words for the one-line receipt left behind when a question or approval
 * card closes. Pure and renderer-agnostic so the wording has one home.
 */

/** Why a request closed without the person answering it here (the `input-required-resolved` reasons). */
export type RequestOutcomeReason = 'timeout' | 'auto_approved' | 'decided' | 'cancelled' | 'exited';

const OUTCOME_REASONS: ReadonlySet<unknown> = new Set(['timeout', 'auto_approved', 'decided', 'cancelled', 'exited']);

/** Adapters send the reason as plain text; this is the check before it is trusted. */
export function isRequestOutcomeReason(value: unknown): value is RequestOutcomeReason {
  return OUTCOME_REASONS.has(value);
}

export interface RequestReceiptWords {
  text: string;
  /** The tool the request was about, when the agent named one. Shown after the sentence. */
  subject?: string;
}

export interface ClosedRequestFacts {
  /** True for an approval of an action, false for a question. */
  permission: boolean;
  /** How long the card was on screen, as the renderer measured it. */
  waitedMs?: number;
  tool?: string;
}

export type UserChoice =
  | { kind: 'allowed'; scope: 'once' | 'session' | 'always'; tool?: string }
  | { kind: 'denied'; tool?: string }
  | { kind: 'dismissed'; tool?: string }
  | { kind: 'answered'; answer: string }
  | { kind: 'skipped' }
  | { kind: 'chose'; label: string }
  | { kind: 'approved' | 'declined'; what: string }
  /** A secret was stored. Names what it was for, never its value. */
  | { kind: 'saved'; what: string }
  | { kind: 'auto-approve' };

const ANSWER_PREVIEW_CHARS = 60;
/** Half a minute rounds up to a minute, so a 60 s timeout never reads "in time". */
const SHORTEST_NAMED_WAIT_MS = 30_000;

function waited(ms: number | undefined): string {
  if (ms === undefined || ms < SHORTEST_NAMED_WAIT_MS) return 'time';
  const minutes = Math.round(ms / 60_000);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** The first 60 characters of an answer on one line, never splitting a character. */
export function previewAnswer(answer: string): string {
  const characters = Array.from(answer.replace(/\s+/g, ' ').trim());
  const kept = characters.slice(0, ANSWER_PREVIEW_CHARS).join('');
  return characters.length > ANSWER_PREVIEW_CHARS ? `${kept}…` : kept;
}

export function describeRequestOutcome(reason: RequestOutcomeReason, facts: ClosedRequestFacts): RequestReceiptWords {
  const subject = facts.tool?.trim() || undefined;
  const text = (() => {
    switch (reason) {
      case 'timeout':
        return `No answer in ${waited(facts.waitedMs)}; ${facts.permission ? 'nothing ran' : 'the question was dropped'}`;
      case 'auto_approved': return 'Allowed automatically';
      case 'decided': return 'Answered elsewhere';
      case 'cancelled': return 'Cancelled when the session was stopped';
      case 'exited': return 'Cancelled when the session closed';
    }
  })();
  return subject ? { text, subject } : { text };
}

function withTool(sentence: string, tool: string | undefined): string {
  return tool?.trim() ? `${sentence}: ${tool.trim()}` : sentence;
}

export function describeUserChoice(choice: UserChoice): RequestReceiptWords {
  switch (choice.kind) {
    case 'allowed': {
      const sentence = choice.scope === 'once' ? 'You allowed once'
        : choice.scope === 'session' ? 'You allowed for this session' : 'You always allowed';
      return { text: withTool(sentence, choice.tool) };
    }
    case 'denied': return { text: withTool('You said no', choice.tool) };
    case 'dismissed': return { text: withTool('You dismissed', choice.tool) };
    case 'answered': return { text: `You answered: ${previewAnswer(choice.answer)}` };
    case 'skipped': return { text: 'You skipped the question' };
    case 'chose': return { text: `You chose: ${previewAnswer(choice.label)}` };
    case 'approved': return { text: `You approved: ${previewAnswer(choice.what)}` };
    case 'declined': return { text: `You said no: ${previewAnswer(choice.what)}` };
    case 'saved': return { text: `You saved: ${previewAnswer(choice.what)}` };
    case 'auto-approve': return { text: 'You switched on auto-approve' };
  }
}

const STOPPED_STATUSES = new Set(['interrupting', 'cancelling', 'interrupt-escalating']);
const CLEARING_STATUSES = new Set([
  ...STOPPED_STATUSES,
  'terminated', 'failed', 'error', 'cancelled', 'hibernated', 'initializing', 'respawning', 'waking',
]);

/** True for a session status under which a question or approval that was waiting can no longer be answered. */
export function statusClearsOpenRequests(status: string | undefined): boolean {
  return status !== undefined && CLEARING_STATUSES.has(status);
}

/**
 * A session status that clears its open cards, as the reason a card would have
 * been closed with: a stop cancels the turn; anything else means the process
 * that asked has gone (closed, crashed, put to sleep or restarted).
 */
export function outcomeReasonForStatus(status: string | undefined): RequestOutcomeReason {
  return status !== undefined && STOPPED_STATUSES.has(status) ? 'cancelled' : 'exited';
}
