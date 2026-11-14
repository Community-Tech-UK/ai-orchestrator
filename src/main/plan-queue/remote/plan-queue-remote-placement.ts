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
}

export type Placement =
  | { kind: 'there'; computer: RemoteComputer }
  /** `reason` is null when running here is by design or nothing takes jobs, which needs no note. */
  | { kind: 'here'; reason: string | null };

/** The AI tools a job on another computer can use. Their names come from `providerName`. */
const REMOTE_TOOLS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** Why this computer can't take the job, in words, or null when it can. */
export function refusalFor(computer: QueueJobComputer, input: PlacementInput): string | null {
  if (computer.paused) return `${computer.label} is paused`;
  if (!input.nodes.isConnected(computer.nodeId)) return `${computer.label} is away`;
  const capabilities = input.nodes.capabilities(computer.nodeId);
  if (capabilities?.queueJobs !== QUEUE_JOBS_PROTOCOL) return `${computer.label} needs the newer Harness before it can take jobs`;
  const signIn = signInProblem(computer, capabilities, input.run.workerProvider ?? undefined);
  if (signIn) return signIn;
  if (input.jobsOn(computer.nodeId) >= computer.jobsAtOnce) {
    return `${computer.label} already has ${computer.jobsAtOnce} job${computer.jobsAtOnce === 1 ? '' : 's'} (its limit)`;
  }
  const check = computer.projects[input.projectKey];
  if (!check) return `${computer.label} hasn't been checked for this project yet`;
  if (!check.ok) return `${computer.label} failed the check for this project${check.problem ? ` (${check.problem})` : ''}`;
  return null;
}

function signInProblem(computer: QueueJobComputer, capabilities: WorkerNodeCapabilities, provider: string | undefined): string | null {
  const named = provider && provider !== 'auto' ? provider : null;
  if (named && !REMOTE_TOOLS.has(named)) return `${computer.label} only runs Claude and Codex jobs, and this one uses ${named}`;
  if (!capabilities.signIns) return `${computer.label} hasn't reported its sign-ins yet`;
  const signedIn = capabilities.signIns.filter(entry => entry.state === 'signed-in' && (!named || entry.provider === named));
  if (signedIn.length) return null;
  return named
    ? `${computer.label} isn't signed in to ${providerName(named)}`
    : `${computer.label} isn't signed in to Claude or Codex`;
}

export function placeJob(input: PlacementInput): Placement {
  if (input.run.kind !== 'plans') return { kind: 'here', reason: null };
  if (input.run.config.keepOnThisMac === true) return { kind: 'here', reason: null };
  const taking = input.computers.filter(computer => computer.takesJobs);
  if (!taking.length) return { kind: 'here', reason: null };
  const reasons: string[] = [];
  for (const computer of taking) {
    const refusal = refusalFor(computer, input);
    if (!refusal) return { kind: 'there', computer: { nodeId: computer.nodeId, label: computer.label } };
    reasons.push(refusal);
  }
  return { kind: 'here', reason: `This job runs on this Mac because ${reasons.join(', and ')}.` };
}
