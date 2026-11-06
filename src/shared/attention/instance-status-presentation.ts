/**
 * One status presenter (Oct-2 Phase E step 5 / backlog U4; replaces Phase 3
 * step 8b).
 *
 * Five places used to describe one session state in five vocabularies: the
 * sidebar dot, the session row, the child list, the phone push and a shared
 * constants file nothing imported. They disagreed ("Processing..." / "Working" /
 * "running"; a question called "needs approval" on the phone; respawning purple
 * in one file and teal in another). Every surface now asks this module, so the
 * same session reads the same everywhere.
 *
 * - `label` is one of a closed list of plain words.
 * - `tone` picks the colour from ONE table.
 * - `detail` is a lowercase fragment that follows "label — " in a tooltip.
 * - A question ("Needs your answer") is never an approval ("Needs your OK").
 * - A wait reason can explain more than the status alone: a session parked on a
 *   usage limit sits in `idle`, and signed-out is not visible in any status.
 *
 * The phone app imports this presenter through `apps/mobile/src/app/core/status.ts`;
 * `phone-status-parity.spec.ts` also checks the native widget colour fallback. Guard: `instance-status-presentation.guard.spec.ts`.
 */

import type { InstanceStatus } from '@contracts/types/instance-events';
import type { InstanceWaitReason } from '../types/instance-wait-reason.types';
import { accountFamilyName, PRODUCT_NAME, providerName } from '../display-names';
import { ALL_INSTANCE_STATUSES, attentionLevelForInstanceStatus } from './attention-level';

/** Every label a session status can show. Adding one is a product decision. */
export const INSTANCE_STATUS_LABELS = [
  'Working',
  'Thinking',
  'Needs your answer',
  'Needs your OK',
  'Restarting',
  'Stopping',
  'Asleep',
  'Stopped',
  'Problem',
  'Ready',
] as const;

export type InstanceStatusLabel = (typeof INSTANCE_STATUS_LABELS)[number];

/**
 * The single colour table. `background` is not a status of its own: it marks a
 * session that is idle between turns while the provider still owns background
 * work.
 */
export const INSTANCE_STATUS_TONE_COLORS = {
  working: '#3b82f6',
  thinking: '#4fa3a5',
  attention: '#f59e0b',
  stopping: '#b89a66',
  asleep: '#4b5563',
  quiet: '#6b7280',
  ok: '#10b981',
  warning: '#f97316',
  danger: '#ef4444',
  background: '#7aa2c8',
} as const;

export type InstanceStatusTone = keyof typeof INSTANCE_STATUS_TONE_COLORS;

export interface InstanceStatusPresentation {
  label: InstanceStatusLabel;
  tone: InstanceStatusTone;
  /** Hex colour of `tone`, from the one table. */
  color: string;
  /** Lowercase fragment that follows "label — "; empty when the label says it all. */
  detail: string;
  /** The dot pulses: live, but waiting or changing state rather than working. */
  pulse: boolean;
  /** The dot is the spinning ring: the agent is actively working or stopping. */
  spinner: boolean;
  /** The session is doing or changing something by itself. */
  inProgress: boolean;
  /** A live question or permission prompt is waiting for a person. */
  needsYou: boolean;
}

export interface InstanceStatusContext {
  /** Live provider-owned background tasks; only changes an idle session. */
  readonly backgroundWorkCount?: number;
}

interface StatusRow {
  label: InstanceStatusLabel;
  tone: InstanceStatusTone;
  detail: string;
  pulse?: true;
  spinner?: true;
  inProgress?: true;
}

const STATUS_ROWS: Readonly<Record<InstanceStatus, StatusRow>> = {
  initializing: { label: 'Working', tone: 'working', detail: 'starting up', pulse: true, inProgress: true },
  ready: { label: 'Ready', tone: 'ok', detail: '' },
  idle: { label: 'Ready', tone: 'ok', detail: '' },
  busy: { label: 'Working', tone: 'working', detail: '', spinner: true, inProgress: true },
  processing: { label: 'Working', tone: 'working', detail: '', spinner: true, inProgress: true },
  thinking_deeply: { label: 'Thinking', tone: 'thinking', detail: 'thinking for a while', spinner: true, inProgress: true },
  waiting_for_input: { label: 'Needs your answer', tone: 'attention', detail: 'the agent asked you a question', pulse: true },
  waiting_for_permission: { label: 'Needs your OK', tone: 'attention', detail: 'the agent is asking permission to do something', pulse: true },
  interrupting: { label: 'Stopping', tone: 'stopping', detail: 'stopping the current work', pulse: true, spinner: true, inProgress: true },
  cancelling: { label: 'Stopping', tone: 'stopping', detail: 'finishing the stop', pulse: true, spinner: true, inProgress: true },
  'interrupt-escalating': {
    label: 'Stopping',
    tone: 'danger',
    detail: `it didn't stop, so ${PRODUCT_NAME} is forcing it to stop`,
    pulse: true,
    spinner: true,
    inProgress: true,
  },
  cancelled: { label: 'Stopped', tone: 'quiet', detail: 'stopped before it finished' },
  superseded: { label: 'Stopped', tone: 'quiet', detail: 'replaced by an edited copy' },
  respawning: { label: 'Restarting', tone: 'thinking', detail: 'picking up where it left off', pulse: true, inProgress: true },
  hibernating: { label: 'Asleep', tone: 'asleep', detail: 'going to sleep to save memory', pulse: true, inProgress: true },
  hibernated: { label: 'Asleep', tone: 'asleep', detail: 'send a message to wake it' },
  waking: { label: 'Restarting', tone: 'thinking', detail: 'waking up', pulse: true, inProgress: true },
  degraded: {
    label: 'Problem',
    tone: 'warning',
    detail: `lost contact with its computer, ${PRODUCT_NAME} is moving it`,
  },
  error: { label: 'Problem', tone: 'danger', detail: 'the session hit an error' },
  failed: { label: 'Problem', tone: 'danger', detail: "the session couldn't carry on" },
  terminated: { label: 'Stopped', tone: 'quiet', detail: 'this session has closed' },
};

/** What an unrecognised status (a newer peer, a stale snapshot) reads as. */
const UNKNOWN_STATUS_ROW: StatusRow = { label: 'Working', tone: 'working', detail: '' };

const KNOWN_STATUSES: ReadonlySet<string> = new Set(ALL_INSTANCE_STATUSES);

export function isInstanceStatus(value: unknown): value is InstanceStatus {
  return typeof value === 'string' && KNOWN_STATUSES.has(value);
}

/** Labels a wait reason may replace: states that say nothing about being stuck. */
const OVERRIDABLE_LABELS: ReadonlySet<InstanceStatusLabel> = new Set([
  'Working', 'Thinking', 'Restarting', 'Asleep', 'Ready',
]);

function waitReasonDetail(wait: InstanceWaitReason): string {
  switch (wait.kind) {
    case 'provider-slot':
      return `waiting for another ${providerName(wait.provider)} session to finish`;
    case 'interrupt-ack':
      return 'waiting for the current work to stop';
    case 'terminating':
      return wait.force ? 'closing it by force' : 'closing';
    case 'respawning':
      return wait.strategy === 'native-resume'
        ? 'picking up where it left off'
        : 'restarting with your recent messages carried over';
    case 'resume-proof':
      return 'checking that the conversation was restored';
    case 'remote-heartbeat':
      return 'waiting for its computer to reconnect';
    case 'mutex':
      return 'finishing the previous action first';
    case 'quota-park':
      return `paused until your ${accountFamilyName(wait.provider)} allowance resets`;
    case 'auth-required':
      return `signed out of ${accountFamilyName(wait.provider)}`;
    case 'backoff':
      return 'trying again shortly';
    default:
      return assertNever(wait);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled wait reason: ${JSON.stringify(value)}`);
}

function build(row: StatusRow, needsYou: boolean): InstanceStatusPresentation {
  return {
    label: row.label,
    tone: row.tone,
    color: INSTANCE_STATUS_TONE_COLORS[row.tone],
    detail: row.detail,
    pulse: row.pulse === true,
    spinner: row.spinner === true,
    inProgress: row.inProgress === true,
    needsYou,
  };
}

/**
 * The one place that turns a session status (plus why it is waiting, if it is)
 * into words and a colour.
 *
 * @hoverTextReadable every word it can return is a literal in this file, so the UI hints check reads them.
 */
export function presentInstanceStatus(
  status: InstanceStatus,
  waitReason?: InstanceWaitReason | null,
  context: InstanceStatusContext = {},
): InstanceStatusPresentation {
  const base = STATUS_ROWS[status] ?? UNKNOWN_STATUS_ROW;
  const needsYou = isInstanceStatus(status) && attentionLevelForInstanceStatus(status) === 'blocked';
  let row: StatusRow = base;

  if (waitReason && !needsYou) {
    const detail = waitReasonDetail(waitReason);
    if (OVERRIDABLE_LABELS.has(base.label) && waitReason.kind === 'auth-required') {
      row = { label: 'Problem', tone: 'warning', detail };
    } else if (OVERRIDABLE_LABELS.has(base.label) && waitReason.kind === 'quota-park') {
      row = { label: 'Asleep', tone: 'asleep', detail };
    } else {
      row = { ...base, detail };
    }
  }

  if (row.label === 'Ready' && (context.backgroundWorkCount ?? 0) > 0) {
    row = { label: 'Working', tone: 'background', detail: 'waiting on background work' };
  }
  return build(row, needsYou);
}

/**
 * "Working — waiting on background work": the sentence for a tooltip or an accessible name.
 *
 * @hoverTextReadable it only joins the label and detail the presenter above holds.
 */
export function describeInstanceStatus(presentation: Pick<InstanceStatusPresentation, 'label' | 'detail'>): string {
  return presentation.detail ? `${presentation.label} — ${presentation.detail}` : presentation.label;
}

/**
 * The coarse key the phone's lock-screen widget uses to pick its colour and
 * symbol. It is a wire contract with phones that were built earlier, so the
 * vocabulary is fixed: the widget translates a key to its own words. A question
 * is `waiting`; only a permission prompt is `needs approval`.
 */
export type LiveActivityStatusKey = 'working' | 'waiting' | 'needs approval' | 'error' | 'idle';

export function liveActivityStatusKey(status: InstanceStatus): LiveActivityStatusKey {
  switch (presentInstanceStatus(status).label) {
    case 'Needs your answer':
      return 'waiting';
    case 'Needs your OK':
      return 'needs approval';
    case 'Problem':
      return 'error';
    case 'Ready':
    case 'Asleep':
    case 'Stopped':
      return 'idle';
    default:
      return 'working';
  }
}
