/**
 * The projects a computer can be checked for, and the check itself: the repositories of the Plan Queue's runs, their
 * names on a computer, and the call that sends one to a computer and records what came back.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { QueueJobComputerSource, QueueJobProjectCheck } from '../../shared/types/plan-queue-computers.types';
import type { QueueJobProject } from '../../shared/types/plan-queue-computers-page.types';
import { queueProjectKey } from '../remote-node/queue-job-rpc-schemas';
import type { RemoteQueueJobs } from '../plan-queue/remote/queue-job-remote';

/**
 * A repository's name on a computer: its folder name and a short fingerprint of its path here. The one way anything
 * (the check, the send, placement) turns a repository on this Mac into a project key, so they always agree.
 */
export function queueProjectKeyFor(repoRoot: string): string {
  return queueProjectKey(repoRoot, value => createHash('sha256').update(value).digest('hex'));
}

/** Each repository once, in the order the runs were given (newest first). */
export function knownQueueProjects(runs: readonly { workspaceCwd: string }[]): QueueJobProject[] {
  const seen = new Set<string>();
  const projects: QueueJobProject[] = [];
  for (const { workspaceCwd } of runs) {
    if (seen.has(workspaceCwd)) continue;
    seen.add(workspaceCwd);
    projects.push({ key: queueProjectKeyFor(workspaceCwd), name: basename(workspaceCwd) || workspaceCwd, repoRoot: workspaceCwd });
  }
  return projects;
}

/**
 * Checks a project on a computer: sends the repository's current branch there and runs its quick checks. Resolves with
 * the outcome, a failed check included. Rejects when the computer can't be reached or the check can't start.
 */
export type QueueProjectChecker = (nodeId: string, repoRoot: string) => Promise<QueueJobProjectCheck>;

/** The checker backed by `RemoteQueueJobs.projectCheck`: it names the computer the way people do and the branch to send. */
export function remoteProjectChecker(
  remote: Pick<RemoteQueueJobs, 'projectCheck'>,
  computers: QueueJobComputerSource,
  currentBranchOf: (repoRoot: string) => Promise<string>,
): QueueProjectChecker {
  return async (nodeId, repoRoot) => {
    const computer = computers.list().find(entry => entry.nodeId === nodeId);
    if (!computer) throw new Error('That computer is not paired with this Mac.');
    const baseBranch = await currentBranchOf(repoRoot);
    if (!baseBranch) throw new Error(`${basename(repoRoot)} is not on a branch, so there is nothing to send.`);
    return remote.projectCheck({ computer: { nodeId, label: computer.label }, repoRoot, baseBranch });
  };
}
