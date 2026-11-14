/**
 * The one object the Plan Queue coordinator calls to run a job on another computer. Spec:
 * docs/specs/2026-11-08-plan-queue-jobs-on-other-computers_spec_planned.md.
 *
 * Order of a round, from the coordinator's side:
 *   send -> prepare -> (the session runs there) -> readReport -> [session closed] -> collect -> checkpoint (unchanged)
 *   -> send (the new commit) -> prepare (next turn; moves the far folder to it) -> deleteLeftOut(collect.leftOut)
 * `send` also refreshes the item's "what was sent" record from the main checkout; `collect` writes returned planning
 * documents into the main checkout (before `checkpoint`) and updates that record. Nothing here reads or writes the
 * job row or the queue's state: every value comes in as a parameter.
 */
import type { PlanQueueItem } from '../plan-queue.types';
import type { QueueJobProjectCheck } from '../../../shared/types/plan-queue-computers.types';
import type { QueueDeleteLeftOutResult, QueuePrepareResult } from '../../remote-node/queue-job-rpc-schemas';
import { collectAndApply, type CopyBackRefusalReason } from './queue-job-copy-back';
import { QueueJobGitError, gitText } from './queue-job-git';
import { QueueJobLinkError, createQueueJobLink, queueProjectKeyFor, type QueueJobLink } from './queue-job-link';
import {
  applyReturnedDocuments, clearSentRecord, readSentRecord, recordedDocuments, refreshSentRecord, writeSentRecord,
  type ApplyReturnedResult,
} from './queue-job-planning-docs';
import { sendCommit } from './queue-job-send';

/** The computer a job runs on. `label` is how people name it ("the Windows PC"); it goes into every sentence. */
export interface RemoteComputer {
  nodeId: string;
  label: string;
}

/** The parts of the queue item these calls read. `branchName` must be set (the job's branch, `queue/...`). */
export type RemoteJobItem = Pick<PlanQueueItem, 'id' | 'sourceRef' | 'branchName'>;

export interface RemoteSendArgs {
  computer: RemoteComputer;
  /** This Mac's repository (the root checkout). */
  repoRoot: string;
  item: RemoteJobItem;
  /** The commit to send: the job's folder's HEAD. */
  commit: string;
  /** The base branch's name here (for example `main`): its tip and recent history go too. */
  baseBranch: string;
  /** The commit the job started from. */
  startCommit: string;
  /** The last commit exchanged for this job (what the far side already has), or null for the first send. */
  lastExchanged: string | null;
}

export interface RemoteSendResult {
  commit: string;
  /** Bytes of git pack sent (0 when the computer already had everything). */
  packBytes: number;
  chunks: number;
  /** Planning documents now recorded as sent, by repository path. */
  documentsSent: string[];
}

export interface RemotePrepareArgs {
  computer: RemoteComputer;
  repoRoot: string;
  item: RemoteJobItem;
  /** The commit last sent for this job. */
  commit: string;
  /** The worker turn about to start; its report file is named from it. */
  turnId: string;
}

export interface RemoteCollectArgs {
  computer: RemoteComputer;
  repoRoot: string;
  item: RemoteJobItem;
  /** The job's folder on this Mac (its HEAD must be `expectedParent`). */
  jobFolder: string;
  /** The last commit exchanged: the collected commit's parent. */
  expectedParent: string;
}

/** Why a collect changed nothing here. `session-running`, `wrong-parent`, `agent-committed`, `path-outside`, `no-copy` and `not-prepared` are the worker's own refusals. */
export type RemoteCollectRefusalReason = CopyBackRefusalReason;

export type RemoteCollectResult =
  | {
    outcome: 'refused';
    reason: RemoteCollectRefusalReason;
    /** Plain English, ready for the job's note. Nothing was changed in the job's folder or the main checkout. */
    message: string;
  }
  | {
    outcome: 'collected';
    /** The commit on the computer that holds what the agent changed (parent = `expectedParent`; not on the job's branch). */
    commit: string;
    /** How the job's folder was changed: not at all (no change), applied, or already applied by an earlier try. */
    applied: 'none' | 'applied' | 'already-applied';
    changedFiles: string[];
    /** New planning files now in the job's folder that `checkpoint` will move to the main checkout and leave out of the commit. Pass to `deleteLeftOut` once the new commit is sent. */
    leftOut: string[];
    /** What happened to the planning documents; `documents.hold` is set when the job must be parked for James. */
    documents: Omit<ApplyReturnedResult, 'sent'>;
    /** One plain sentence for the job's timeline. */
    summary: string;
  };

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function requireBranch(item: RemoteJobItem): string {
  if (!item.branchName) throw new Error(`The job ${item.id} has no branch yet, so it cannot run on another computer.`);
  return item.branchName;
}

/** Seconds as people read them: "43 s", "0.2 s". */
function seconds(ms: number): string {
  const value = ms / 1000;
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} s`;
}

export class RemoteQueueJobs {
  constructor(private readonly link: QueueJobLink = createQueueJobLink()) {}

  /** True when the computer is connected and advertises `queueJobs: 1`. */
  supports(nodeId: string): boolean {
    return this.link.supports(nodeId);
  }

  /** The project's name on the computers, also the key of `QueueJobComputer.projects`. */
  projectKey(repoRoot: string): string {
    return queueProjectKeyFor(repoRoot);
  }

  /** Send `commit` (a thin pack against what the computer has), then record the planning documents as sent. */
  async send(args: RemoteSendArgs): Promise<RemoteSendResult> {
    const { computer, repoRoot, item } = args;
    const sent = await sendCommit({
      link: this.link, nodeId: computer.nodeId, repoRoot, project: queueProjectKeyFor(repoRoot), jobId: item.id,
      commit: args.commit, baseBranch: args.baseBranch, startCommit: args.startCommit, lastExchanged: args.lastExchanged,
    });
    const record = await refreshSentRecord(repoRoot, item.sourceRef, await readSentRecord(repoRoot, item.id));
    await writeSentRecord(repoRoot, item.id, record);
    return { commit: sent.commit, packBytes: sent.packBytes, chunks: sent.chunks, documentsSent: Object.keys(record) };
  }

  /** Make the job's folder, planning folder and report folder there; moves the far folder to `commit`. Needs `send` first. */
  async prepare(args: RemotePrepareArgs): Promise<QueuePrepareResult> {
    const { computer, repoRoot, item } = args;
    const documents = recordedDocuments(await readSentRecord(repoRoot, item.id));
    if (!documents.length) throw new Error(`Nothing was sent for the job ${item.id} yet, so the computer has no plan to work from.`);
    return this.link.prepare(computer.nodeId, {
      project: queueProjectKeyFor(repoRoot), jobId: item.id, branch: requireBranch(item), commit: args.commit,
      documents, turnId: args.turnId,
    });
  }

  /**
   * Take the agent's changes back: the code into the job's folder as uncommitted changes, the planning documents into
   * the main checkout. A refusal returns `outcome: 'refused'` and changes nothing; an unreachable computer throws
   * `QueueJobLinkError`.
   */
  async collect(args: RemoteCollectArgs): Promise<RemoteCollectResult> {
    const { computer, repoRoot, item } = args;
    const back = await collectAndApply({
      link: this.link, nodeId: computer.nodeId, computerLabel: computer.label, repoRoot,
      project: queueProjectKeyFor(repoRoot), jobId: item.id, branch: requireBranch(item),
      jobFolder: args.jobFolder, expectedParent: args.expectedParent,
    });
    if ('refused' in back) return { outcome: 'refused', reason: back.refused.reason, message: back.refused.message };
    const { sent, ...documents } = await applyReturnedDocuments({
      repoRoot, itemId: item.id, computerLabel: computer.label, sent: await readSentRecord(repoRoot, item.id),
      documents: back.documents, deleted: back.deleted,
    });
    await writeSentRecord(repoRoot, item.id, sent);
    const parts = [
      back.applied === 'none'
        ? `${computer.label} changed no files.`
        : `Copied ${plural(back.changedFiles.length, 'changed file', 'changed files')} back from ${computer.label}.`,
    ];
    if (documents.replaced.length) parts.push(`Updated ${documents.replaced.join(', ')} here.`);
    if (documents.created.length) parts.push(`Copied the new ${documents.created.join(', ')} here.`);
    if (documents.beside.length && !documents.hold) parts.push(`Saved ${documents.beside.map(file => file.copy).join(', ')} beside the existing file.`);
    if (documents.hold) parts.push(`${documents.hold.detail}`);
    if (documents.deletedFarSide.length) parts.push(`${computer.label} deleted ${documents.deletedFarSide.join(', ')}; it is still here.`);
    if (documents.failed.length || documents.rejected.length) {
      parts.push(`Could not copy ${[...documents.failed, ...documents.rejected].map(file => file.path).join(', ')}.`);
    }
    return {
      outcome: 'collected', commit: back.commit, applied: back.applied, changedFiles: back.changedFiles,
      leftOut: back.leftOut, documents, summary: parts.join(' '),
    };
  }

  /** The named turn's report file text, or null when the turn wrote none. */
  async readReport(args: { computer: RemoteComputer; item: RemoteJobItem; turnId: string }): Promise<string | null> {
    return (await this.link.readReport(args.computer.nodeId, { jobId: args.item.id, turnId: args.turnId })).text;
  }

  /** Delete these paths (the `leftOut` of the last collect) from the job's folder there. */
  async deleteLeftOut(args: { computer: RemoteComputer; repoRoot: string; item: RemoteJobItem; files: readonly string[] }): Promise<QueueDeleteLeftOutResult> {
    if (!args.files.length) return { deleted: [], skipped: [] };
    return this.link.deleteLeftOut(args.computer.nodeId, {
      project: queueProjectKeyFor(args.repoRoot), jobId: args.item.id, branch: requireBranch(args.item), files: [...args.files],
    });
  }

  /** Remove the job's folders there and forget what was sent. Throws `QueueJobLinkError` when the computer is away (then call `forget` when the job ends here). */
  async remove(args: { computer: RemoteComputer; repoRoot: string; item: RemoteJobItem }): Promise<boolean> {
    const { removed } = await this.link.remove(args.computer.nodeId, {
      project: queueProjectKeyFor(args.repoRoot), jobId: args.item.id, branch: requireBranch(args.item),
    });
    await clearSentRecord(args.repoRoot, args.item.id);
    return removed;
  }

  /** Forget what was sent for the item, without asking the computer (the job ended here while the computer was away). */
  async forget(args: { repoRoot: string; item: Pick<RemoteJobItem, 'id'> }): Promise<void> {
    await clearSentRecord(args.repoRoot, args.item.id);
  }

  /**
   * Send the base branch's tip and run its quick checks there (`typecheck` and `lint`). A failed check, or a computer
   * that answers with an error, returns `ok: false` with the reason in words; an unreachable or out-of-date computer
   * throws `QueueJobLinkError`, because that says nothing about the project.
   */
  async projectCheck(args: { computer: RemoteComputer; repoRoot: string; baseBranch: string }): Promise<QueueJobProjectCheck> {
    const { computer, repoRoot, baseBranch } = args;
    const failed = (problem: string): QueueJobProjectCheck => ({ ok: false, checkedAt: Date.now(), problem, summary: problem });
    let tip: string;
    try { tip = await gitText(['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`], repoRoot); }
    catch (error) {
      if (!(error instanceof QueueJobGitError)) throw error;
      return failed(`The branch ${baseBranch} was not found in this repository.`);
    }
    const jobId = 'project-check';
    const project = queueProjectKeyFor(repoRoot);
    try {
      await sendCommit({ link: this.link, nodeId: computer.nodeId, repoRoot, project, jobId, commit: tip, baseBranch, startCommit: tip, lastExchanged: null });
      const result = await this.link.projectCheck(computer.nodeId, { project, jobId, scripts: ['typecheck', 'lint'] });
      const took = result.steps.reduce((total, step) => total + step.ms, 0);
      const copied = result.copyMs === null ? '' : `; a job folder's dependencies took ${seconds(result.copyMs)}`;
      if (result.ok) {
        return { ok: true, checkedAt: Date.now(), problem: null, summary: `Checks took ${seconds(took)}${copied}.` };
      }
      const step = result.steps.find(candidate => !candidate.ok);
      const problem = result.problem ?? (step ? `${step.name} failed on ${computer.label}.` : `The checks failed on ${computer.label}.`);
      return { ok: false, checkedAt: Date.now(), problem, summary: problem };
    } catch (error) {
      if (error instanceof QueueJobLinkError && error.kind === 'failed') return failed(error.message);
      throw error;
    }
  }
}
