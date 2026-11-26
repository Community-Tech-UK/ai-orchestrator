/**
 * Which computer runs a job (plan item 3.2). Pure: everything it needs comes in as a value, so each refusal is
 * a plain spec. A plan job goes to the first computer, in the Computers page's order, that takes Plan Queue jobs,
 * isn't paused, is connected and new enough, is signed in for the job's AI tool, has room and has passed the
 * check for this project; otherwise it runs here and the reason goes on the job's timeline.
 */
import { providerName } from '../../../shared/display-names';
import type { QueueJobComputer } from '../../../shared/types/plan-queue-computers.types';
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';
import { QUEUE_JOBS_PROTOCOL } from '../../remote-node/queue-job-rpc-schemas';
import type { PlanQueueItem, PlanQueueRun } from '../plan-queue.types';
import type { RemoteComputer } from './queue-job-remote';

/** What placement needs to know about the live connection to each computer. */
export interface QueueJobNodeView {
  isConnected(nodeId: string): boolean;
  capabilities(nodeId: string): WorkerNodeCapabilities | undefined;
}

export interface PlacementInput {
  run: Pick<PlanQueueRun, 'kind' | 'workerProvider' | 'config'>;
  item: Pick<PlanQueueItem, 'id'>;
  computers: readonly QueueJobComputer[];
  nodes: QueueJobNodeView;
  /** Jobs now holding a place on this computer (the caller counts them). */
  jobsOn(nodeId: string): number;
  /** The key this project's check result is stored under. */
  projectKey: string;
  /**
   * The Computers page's "Use this Mac when the others are busy or away". Off means a job some other computer could take
   * waits for one instead of running here. Absent reads as on, as the file does.
   */
  useThisMac?: boolean;
}

export type Placement =
  | { kind: 'there'; computer: RemoteComputer }
  /** `reason` is null when running here is by design or nothing takes jobs, which needs no note. */
  | { kind: 'here'; reason: string | null }
  /** This Mac is switched off for jobs and a computer that could take this one is busy, paused or away: the job holds. */
  | { kind: 'wait'; reason: string };

/** The AI tools a job on another computer can use. Their names come from `providerName`. */
const REMOTE_TOOLS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** Why a computer can't take the job, and whether it might later: `soon` is true for busy, paused or away, false for a missing tool, sign-in or check. */
export interface Refusal { text: string; soon: boolean }

/** Why this computer can't take the job, in words, or null when it can. */
export function refusalFor(computer: QueueJobComputer, input: PlacementInput): string | null {
  return refusalDetail(computer, input)?.text ?? null;
}

/**
 * Lasting problems come first, from whatever is known even while the computer is paused or away, so a computer that
 * could never take the job doesn't make it wait. An away computer's report is usually gone, and then only "away" is known.
 */
function refusalDetail(computer: QueueJobComputer, input: PlacementInput): Refusal | null {
  const lasting = lastingProblem(computer, input);
  if (lasting) return { text: lasting, soon: false };
  if (computer.paused) return { text: `${computer.label} is paused`, soon: true };
  if (!input.nodes.isConnected(computer.nodeId)) return { text: `${computer.label} is away`, soon: true };
  if (input.jobsOn(computer.nodeId) >= computer.jobsAtOnce) {
    return { text: `${computer.label} already has ${computer.jobsAtOnce} job${computer.jobsAtOnce === 1 ? '' : 's'} (its limit)`, soon: true };
  }
  return null;
}

function lastingProblem(computer: QueueJobComputer, input: PlacementInput): string | null {
  const provider = input.run.workerProvider ?? undefined;
  const named = provider && provider !== 'auto' ? provider : null;
  if (named && !REMOTE_TOOLS.has(named)) return `${computer.label} only runs Claude and Codex jobs, and this one uses ${named}`;
  const capabilities = input.nodes.capabilities(computer.nodeId);
  const reported = capabilities !== undefined || input.nodes.isConnected(computer.nodeId);
  if (reported) {
    if (capabilities?.queueJobs !== QUEUE_JOBS_PROTOCOL) return `${computer.label} needs the newer Harness before it can take jobs`;
    const signIn = signInProblem(computer, capabilities, named);
    if (signIn) return signIn;
  }
  const check = computer.projects[input.projectKey];
  if (!check) return `${computer.label} hasn't been checked for this project yet`;
  if (!check.ok) return `${computer.label} failed the check for this project${check.problem ? ` (${check.problem})` : ''}`;
  return null;
}

function signInProblem(computer: QueueJobComputer, capabilities: WorkerNodeCapabilities, named: string | null): string | null {
  if (!capabilities.signIns) return `${computer.label} hasn't reported its sign-ins yet`;
  const signedIn = capabilities.signIns.filter(entry => entry.state === 'signed-in' && (!named || entry.provider === named));
  if (signedIn.length) return null;
  return named
    ? `${computer.label} isn't signed in to ${providerName(named)}`
    : `${computer.label} isn't signed in to Claude or Codex`;
}

/**
 * With this Mac switched off for jobs, a job waits when some computer set to take jobs is only busy, paused or away,
 * and runs here, with the reason on its timeline, only when no computer could take it at all (nothing set to take jobs,
 * a tool not signed in, a project not checked). The same words say which.
 */
export function placeJob(input: PlacementInput): Placement {
  if (input.run.kind !== 'plans') return { kind: 'here', reason: null };
  if (input.run.config.keepOnThisMac === true) return { kind: 'here', reason: null };
  const switchedOff = input.useThisMac === false;
  const taking = input.computers.filter(computer => computer.takesJobs);
  if (!taking.length) {
    return { kind: 'here', reason: switchedOff ? 'This job runs on this Mac because no other computer is set to take Plan Queue jobs.' : null };
  }
  const refusals: Refusal[] = [];
  for (const computer of taking) {
    const refusal = refusalDetail(computer, input);
    if (!refusal) return { kind: 'there', computer: { nodeId: computer.nodeId, label: computer.label } };
    refusals.push(refusal);
  }
  const reasons = refusals.map(refusal => refusal.text).join(', and ');
  if (switchedOff && refusals.some(refusal => refusal.soon)) {
    return { kind: 'wait', reason: `Waiting for a computer: ${reasons}. This Mac is switched off for jobs.` };
  }
  return { kind: 'here', reason: `This job runs on this Mac because ${reasons}.` };
}
