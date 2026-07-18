import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import type { LoopStatus } from '../../../../shared/types/loop.types';
import type { InstanceStatus } from '../../core/state/instance/instance.types';
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
} from '../../../../shared/types/automation.types';
import type { RepoJobRecord, RepoJobStatus } from '../../../../shared/types/repo-job.types';
import {
  automationRunStatusToPhase,
  instanceStatusToPhase,
  loopStatusToPhase,
  type WorkflowLifecyclePhase,
} from '../../../../shared/types/workflow-lifecycle.types';
import { NO_WORKSPACE_KEY, toWorkspaceId } from '../../../../shared/utils/workspace-key';
import type {
  WorkboardInstanceInput,
  WorkboardItem,
  WorkboardLane,
  WorkboardLanes,
  WorkboardProjectionInput,
  WorkboardRelation,
  WorkboardWorkspaceOption,
} from './workboard.types';
import { WORKBOARD_LANE_ORDER } from './workboard.types';

/** Terminal records stay visible for this long after their effective end time. */
export const WORKBOARD_RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

function assertNever(value: never): never {
  throw new Error(`Unhandled Workboard status: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Source-status → attention-lane policy (exhaustive; a new status is a compile
// error until it is mapped). This is a Workboard attention policy, NOT a
// replacement for WorkflowLifecyclePhase — the coarse phase is retained too.
// ---------------------------------------------------------------------------

/** Instance status → lane (spec §4.2). */
export function instanceStatusToLane(status: InstanceStatus): WorkboardLane {
  switch (status) {
    case 'waiting_for_permission':
    case 'waiting_for_input':
    case 'degraded':
    case 'error':
    case 'failed':
      return 'needs-you';
    case 'initializing':
    case 'busy':
    case 'processing':
    case 'thinking_deeply':
    case 'respawning':
    case 'waking':
    case 'interrupting':
    case 'cancelling':
    case 'interrupt-escalating':
      return 'working';
    case 'hibernating':
    case 'hibernated':
      return 'waiting';
    case 'ready':
    case 'idle':
    case 'terminated':
    case 'cancelled':
    case 'superseded':
      return 'done';
    default:
      return assertNever(status);
  }
}

/** Loop status → lane (spec §4.2). `provider-limit` splits on `endedAt`:
 *  a null end is an active/resumable wait, a set end is a terminal attention. */
export function loopStatusToLane(status: LoopStatus, endedAt: number | null): WorkboardLane {
  switch (status) {
    case 'running':
      return 'working';
    case 'paused':
      return 'waiting';
    case 'provider-limit':
      return endedAt === null ? 'waiting' : 'needs-you';
    case 'completed-needs-review':
    case 'failed':
    case 'error':
    case 'no-progress':
    case 'cap-reached':
    case 'cost-exceeded':
    case 'needs-human-arbitration':
    case 'reviewer-unreliable':
    case 'reviewer-unavailable':
    case 'builder-unreliable':
      return 'needs-you';
    case 'completed':
    case 'cancelled':
      return 'done';
    default:
      return assertNever(status);
  }
}

/** Automation-run status → lane (spec §4.2). */
export function automationRunStatusToLane(status: AutomationRunStatus): WorkboardLane {
  switch (status) {
    case 'running':
      return 'working';
    case 'pending':
      return 'waiting';
    case 'failed':
      return 'needs-you';
    case 'succeeded':
    case 'skipped':
    case 'cancelled':
      return 'done';
    default:
      return assertNever(status);
  }
}

/** Repository-job status → lane (spec §4.2). */
export function repoJobStatusToLane(status: RepoJobStatus): WorkboardLane {
  switch (status) {
    case 'running':
      return 'working';
    case 'queued':
      return 'waiting';
    case 'failed':
      return 'needs-you';
    case 'completed':
    case 'cancelled':
      return 'done';
    default:
      return assertNever(status);
  }
}

/** Repository jobs are not in the shared lifecycle module; project them here. */
export function repoJobStatusToPhase(status: RepoJobStatus): WorkflowLifecyclePhase {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return assertNever(status);
  }
}

function isTerminalPhase(phase: WorkflowLifecyclePhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

// ---------------------------------------------------------------------------
// Lane urgency (needs-you > working > waiting > done)
// ---------------------------------------------------------------------------

const LANE_URGENCY: Record<WorkboardLane, number> = {
  'needs-you': 0,
  working: 1,
  waiting: 2,
  done: 3,
};

/** The most urgent lane across a set of relations (needs-you wins). */
export function mostUrgentLane(lanes: readonly WorkboardLane[]): WorkboardLane {
  return lanes.reduce((best, lane) => (LANE_URGENCY[lane] < LANE_URGENCY[best] ? lane : best), 'done');
}

// ---------------------------------------------------------------------------
// Presentation helpers (also cover behavior migrated from the Fleet dashboard)
// ---------------------------------------------------------------------------

/** Compact relative time. `now` is injected so callers stay deterministic. */
export function relativeTime(ts: number, now: number): string {
  const diffSec = Math.floor((now - ts) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

/** Final path segment, tolerant of trailing separators and either slash style. */
export function basename(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const sep = trimmed.lastIndexOf('/') >= 0 ? '/' : '\\';
  const parts = trimmed.split(sep);
  return parts[parts.length - 1] ?? trimmed;
}

/** Humanize a raw source status for display while the raw value stays on the
 *  relation. `completed-needs-review` → `Completed needs review`, etc. */
export function statusLabel(rawStatus: string): string {
  const words = rawStatus.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function firstLine(text: string, maxChars = 120): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > maxChars ? `${line.slice(0, maxChars - 1).trimEnd()}…` : line;
}

// ---------------------------------------------------------------------------
// Candidate mappers (one per domain)
// ---------------------------------------------------------------------------

interface Candidate {
  relation: WorkboardRelation;
  title: string;
  workingDirectory: string;
  detail?: string;
  progress?: number;
  errorText?: string;
  outputSummary?: string;
  /** Backing instance id for transcript selection, when the record has one. */
  backingInstanceId?: string;
}

function instanceToCandidate(inst: WorkboardInstanceInput): Candidate {
  const phase = instanceStatusToPhase(inst.status);
  return {
    relation: {
      kind: 'instance',
      id: inst.id,
      rawStatus: inst.status,
      phase,
      lane: instanceStatusToLane(inst.status),
      updatedAt: inst.lastActivity,
      terminal: isTerminalPhase(phase),
    },
    title: inst.displayName,
    workingDirectory: inst.workingDirectory,
    detail: inst.currentActivity,
    backingInstanceId: inst.id,
  };
}

function loopToCandidate(loop: LoopRunSummaryPayload): Candidate {
  return {
    relation: {
      kind: 'loop-run',
      id: loop.id,
      rawStatus: loop.status,
      phase: loopStatusToPhase(loop.status),
      lane: loopStatusToLane(loop.status, loop.endedAt),
      updatedAt: loop.endedAt ?? loop.startedAt,
      // A loop is terminal exactly when it has an end time — this correctly
      // treats a resumable `provider-limit` (endedAt null) as still live and a
      // terminal `provider-limit` (endedAt set) as within the retention window.
      terminal: loop.endedAt !== null,
    },
    title: firstLine(loop.initialPrompt) || 'Loop run',
    workingDirectory: loop.workspaceCwd,
    detail: loop.totalIterations > 0 ? `Iteration ${loop.totalIterations}` : undefined,
    // A loop's chatId identifies its owning conversation/instance.
    backingInstanceId: loop.chatId,
  };
}

function automationRunToCandidate(run: AutomationRun, automation: Automation | undefined): Candidate {
  const phase = automationRunStatusToPhase(run.status);
  const workingDirectory =
    run.configSnapshot?.action.workingDirectory ?? automation?.action.workingDirectory ?? '';
  return {
    relation: {
      kind: 'automation-run',
      id: run.id,
      rawStatus: run.status,
      phase,
      lane: automationRunStatusToLane(run.status),
      updatedAt: run.finishedAt ?? run.startedAt ?? run.updatedAt ?? run.createdAt,
      terminal: isTerminalPhase(phase),
    },
    title: run.configSnapshot?.name ?? automation?.name ?? 'Automation run',
    workingDirectory,
    errorText: run.error ?? undefined,
    outputSummary: run.outputSummary ?? undefined,
    backingInstanceId: run.instanceId ?? undefined,
  };
}

function repoJobToCandidate(job: RepoJobRecord): Candidate {
  const phase = repoJobStatusToPhase(job.status);
  return {
    relation: {
      kind: 'repo-job',
      id: job.id,
      rawStatus: job.status,
      phase,
      lane: repoJobStatusToLane(job.status),
      updatedAt: job.completedAt ?? job.startedAt ?? job.createdAt,
      terminal: isTerminalPhase(phase),
    },
    title: job.title ?? job.name,
    workingDirectory: job.workingDirectory,
    detail: job.progressMessage ?? undefined,
    progress: job.progress,
    errorText: job.error ?? undefined,
    outputSummary: job.result?.summary ?? undefined,
    backingInstanceId: job.instanceId ?? job.result?.instanceId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * Build one correlated `WorkboardItem` from a primary candidate and its already
 * resolved related relations. Lane = most urgent across all relations; the
 * update time is the newest relation time. Linkage IDs are collected across all
 * relations plus an explicit backing instance id for transcript selection.
 */
function buildItem(
  primary: Candidate,
  relatedRelations: readonly WorkboardRelation[],
  knownInstanceIds: ReadonlySet<string>,
): WorkboardItem {
  const relations = [primary.relation, ...relatedRelations];
  const lane = mostUrgentLane(relations.map((r) => r.lane));
  const updatedAt = relations.reduce((max, r) => Math.max(max, r.updatedAt), 0);

  const item: WorkboardItem = {
    id: `${primary.relation.kind}:${primary.relation.id}`,
    primary: primary.relation,
    relations,
    lane,
    title: primary.title,
    workspaceId: toWorkspaceId(primary.workingDirectory),
    workingDirectory: primary.workingDirectory,
    statusLabel: statusLabel(primary.relation.rawStatus),
    detail: primary.detail,
    progress: primary.progress,
    errorText: primary.errorText,
    outputSummary: primary.outputSummary,
    updatedAt,
  };

  // Only treat the item as instance-linked when a real instance with that id
  // exists — a terminal loop whose instance is gone must not carry a dangling
  // instanceId (it would move `InstanceStore` selection to nothing on click).
  if (primary.backingInstanceId && knownInstanceIds.has(primary.backingInstanceId)) {
    item.instanceId = primary.backingInstanceId;
  }
  for (const relation of relations) {
    switch (relation.kind) {
      case 'instance':
        item.instanceId ??= relation.id;
        break;
      case 'loop-run':
        item.loopRunId ??= relation.id;
        break;
      case 'automation-run':
        item.automationRunId ??= relation.id;
        break;
      case 'repo-job':
        item.repoJobId ??= relation.id;
        break;
      default:
        return assertNever(relation.kind);
    }
  }
  return item;
}

/** Deterministic tie-break so correlation output never depends on input order. */
function byIdAsc(a: { relation: WorkboardRelation }, b: { relation: WorkboardRelation }): number {
  return a.relation.id < b.relation.id ? -1 : a.relation.id > b.relation.id ? 1 : 0;
}

/**
 * Correlate every source record into `WorkboardItem`s using EXPLICIT IDs only.
 * Primary-source precedence: repo job > automation run > loop run > standalone
 * instance. A higher-precedence record consumes its linked lower records so they
 * do not also appear standalone. Records are never merged by title, path, time,
 * or prompt similarity.
 */
function correlate(input: WorkboardProjectionInput): WorkboardItem[] {
  const instances = new Map<string, Candidate>();
  for (const inst of input.instances) instances.set(inst.id, instanceToCandidate(inst));
  const knownInstanceIds = new Set(instances.keys());
  const loops = new Map<string, Candidate>();
  for (const loop of input.loopRuns) loops.set(loop.id, loopToCandidate(loop));
  const automationsById = new Map(input.automations.map((a) => [a.id, a]));

  const consumedInstances = new Set<string>();
  const consumedLoops = new Set<string>();
  const items: WorkboardItem[] = [];

  const takeInstance = (instanceId: string | undefined): WorkboardRelation | undefined => {
    if (!instanceId) return undefined;
    const candidate = instances.get(instanceId);
    if (!candidate || consumedInstances.has(instanceId)) return undefined;
    consumedInstances.add(instanceId);
    return candidate.relation;
  };
  const takeLoop = (loopRunId: string | null | undefined): Candidate | undefined => {
    if (!loopRunId) return undefined;
    const candidate = loops.get(loopRunId);
    if (!candidate || consumedLoops.has(loopRunId)) return undefined;
    consumedLoops.add(loopRunId);
    return candidate;
  };

  // Tier 1 — repository jobs (highest precedence).
  const repoJobCandidates = input.repoJobs.map(repoJobToCandidate).sort(byIdAsc);
  for (const candidate of repoJobCandidates) {
    const related: WorkboardRelation[] = [];
    const instanceRelation = takeInstance(candidate.backingInstanceId);
    if (instanceRelation) related.push(instanceRelation);
    items.push(buildItem(candidate, related, knownInstanceIds));
  }

  // Tier 2 — automation runs. Consume linked loop + instance.
  const automationCandidates = input.automationRuns
    .map((run) => ({ run, candidate: automationRunToCandidate(run, automationsById.get(run.automationId)) }))
    .sort((a, b) => byIdAsc(a.candidate, b.candidate));
  for (const { run, candidate } of automationCandidates) {
    const related: WorkboardRelation[] = [];
    const loopCandidate = takeLoop(run.loopRunId);
    if (loopCandidate) related.push(loopCandidate.relation);
    // Prefer the run's explicit instance link, else the consumed loop's chat.
    const instanceRelation =
      takeInstance(run.instanceId ?? undefined) ?? takeInstance(loopCandidate?.backingInstanceId);
    if (instanceRelation) related.push(instanceRelation);
    if (!candidate.backingInstanceId && loopCandidate?.backingInstanceId) {
      candidate.backingInstanceId = loopCandidate.backingInstanceId;
    }
    items.push(buildItem(candidate, related, knownInstanceIds));
  }

  // Tier 3 — loop runs not already consumed. Newest consumes the shared instance.
  const loopCandidates = [...loops.entries()]
    .filter(([id]) => !consumedLoops.has(id))
    .map(([, candidate]) => candidate)
    .sort((a, b) => b.relation.updatedAt - a.relation.updatedAt || byIdAsc(a, b));
  for (const candidate of loopCandidates) {
    if (consumedLoops.has(candidate.relation.id)) continue;
    consumedLoops.add(candidate.relation.id);
    const related: WorkboardRelation[] = [];
    const instanceRelation = takeInstance(candidate.backingInstanceId);
    if (instanceRelation) related.push(instanceRelation);
    items.push(buildItem(candidate, related, knownInstanceIds));
  }

  // Tier 4 — standalone instances not consumed above.
  const standaloneInstances = [...instances.values()]
    .filter((candidate) => !consumedInstances.has(candidate.relation.id))
    .sort(byIdAsc);
  for (const candidate of standaloneInstances) {
    items.push(buildItem(candidate, [], knownInstanceIds));
  }

  return items;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Keep live/resumable items always; keep terminal items within the 24h window. */
function withinRetention(item: WorkboardItem, now: number): boolean {
  const isLive = item.relations.some((relation) => !relation.terminal);
  if (isLive) return true;
  return now - item.updatedAt <= WORKBOARD_RETENTION_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

/**
 * Pure projection: correlate every source record into items, then drop terminal
 * items whose effective end time is beyond the 24-hour retention window. Live or
 * resumable items are always retained regardless of age.
 */
export function projectWorkboard(input: WorkboardProjectionInput): WorkboardItem[] {
  return correlate(input).filter((item) => withinRetention(item, input.now));
}

/**
 * Group items into the four lanes with deterministic per-lane ordering:
 *  - Needs You / Working / Done: newest update first;
 *  - Waiting: oldest wait first.
 */
export function buildWorkboardLanes(items: readonly WorkboardItem[]): WorkboardLanes {
  const lanes: WorkboardLanes = { 'needs-you': [], working: [], waiting: [], done: [] };
  for (const item of items) lanes[item.lane].push(item);
  for (const lane of WORKBOARD_LANE_ORDER) {
    const ascending = lane === 'waiting';
    lanes[lane].sort((a, b) => {
      const delta = ascending ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt;
      if (delta !== 0) return delta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  return lanes;
}

/** Derive deduplicated, sorted workspace options from the visible items. */
export function deriveWorkspaceOptions(items: readonly WorkboardItem[]): WorkboardWorkspaceOption[] {
  const byId = new Map<string, WorkboardWorkspaceOption>();
  for (const item of items) {
    const id = item.workspaceId;
    if (byId.has(id)) {
      // Prefer a concrete path over a blank one if we see the same id twice.
      const existing = byId.get(id)!;
      if (!existing.workingDirectory && item.workingDirectory) {
        byId.set(id, workspaceOption(id, item.workingDirectory));
      }
      continue;
    }
    byId.set(id, workspaceOption(id, item.workingDirectory));
  }
  return [...byId.values()].sort((a, b) => {
    const byLabel = a.label.localeCompare(b.label);
    return byLabel !== 0 ? byLabel : a.workingDirectory.localeCompare(b.workingDirectory);
  });
}

function workspaceOption(id: string, workingDirectory: string): WorkboardWorkspaceOption {
  const label = id === NO_WORKSPACE_KEY ? 'No workspace' : basename(workingDirectory) || workingDirectory;
  return { id, label, workingDirectory };
}

/** Filter items to a workspace id, or return all when the sentinel `'all'` is used. */
export function filterItemsByWorkspace(
  items: readonly WorkboardItem[],
  workspaceId: string | 'all',
): WorkboardItem[] {
  if (workspaceId === 'all') return [...items];
  return items.filter((item) => item.workspaceId === workspaceId);
}
