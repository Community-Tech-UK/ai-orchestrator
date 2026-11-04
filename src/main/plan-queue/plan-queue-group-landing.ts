/** Prove that a moved base contains only already-checked members of this group. */
import type { PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import { pathCompareKey } from '../workspace/git/worktree-cleanup';
import { gitExec } from '../workspace/git/git-exec';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { readProvisionedPaths } from './plan-queue-worktree';

type Receipt = PlanQueueVerdict['gatesRun'][number];
type CheckGroup = NonNullable<Receipt['checkGroup']>;
interface GroupProof { group: CheckGroup; testedTree: string; head: string }
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAME_ROUND_STATES = new Set<PlanQueueItem['state']>(['awaiting-slot', 'verifying', 'landing', 'landed']);

function acceptable(receipt: Receipt): boolean {
  if (receipt.timedOut || receipt.classification === 'no-tests-found') return false;
  return receipt.exitCode === 0 && (receipt.classification === 'passed' || receipt.classification === 'not-recognised')
    || receipt.classification === 'failed' && receipt.baseline === 'also-failing-on-base';
}

function receiptProof(item: PlanQueueItem, commands: readonly string[]): GroupProof | null {
  if (item.verdict?.verdict !== 'PASS' || !commands.length || item.verdict.gatesRun.length !== commands.length) return null;
  const first = item.verdict.gatesRun[0];
  const group = first.checkGroup;
  if (!group || !group.id || !HASH.test(group.baseTip) || !first.testedTree || !HASH.test(first.testedTree)
    || !first.head || !HASH.test(first.head) || group.memberItemIds.length < 2 || group.memberItemIds.length > 8
    || new Set(group.memberItemIds).size !== group.memberItemIds.length || !group.memberItemIds.includes(item.id)) return null;
  const identity = JSON.stringify(group);
  if (!item.verdict.gatesRun.every((receipt, index) => receipt.command === commands[index] && acceptable(receipt)
    && receipt.head === first.head && receipt.testedTree === first.testedTree && JSON.stringify(receipt.checkGroup) === identity)) return null;
  return { group, testedTree: first.testedTree, head: first.head };
}

async function ancestor(base: string, tip: string, cwd: string): Promise<boolean> {
  try { await gitExec(['merge-base', '--is-ancestor', base, tip], cwd); return true; }
  catch (error) { if ((error as { code?: unknown }).code === 1) return false; throw error; }
}

/** Recheck synchronously after async syncing, including cancellation before park events arrive. */
export function groupRoundStillIntact(group: CheckGroup, host: Pick<PlanQueueFlowHost, 'store' | 'history'>): boolean {
  return group.memberItemIds.every(id => {
    const member = host.store.getItem(id);
    const run = member ? host.store.getRun(member.runId) : null;
    return member && run && run.status !== 'cancelled' && SAME_ROUND_STATES.has(member.state) && member.verdict?.verdict !== 'FAIL';
  }) && host.history.checkGroupRoundIntact(group.id, group.memberItemIds);
}

/** Called before syncing, while the item's unchanged checked HEAD is still observable. */
export async function groupCoversMovedBase(item: PlanQueueItem, run: PlanQueueRun, baseTip: string,
  host: Pick<PlanQueueFlowHost, 'store' | 'history'>): Promise<boolean> {
  const proof = receiptProof(item, run.config.verifierGates);
  if (!proof || !item.worktreePath || item.checkpointCommit !== proof.head || run.status === 'cancelled') return false;
  if (await gitExec(['rev-parse', 'HEAD'], item.worktreePath) !== proof.head) return false;
  const provisioned = await readProvisionedPaths(item.worktreePath);
  if (await gitExec(['status', '--porcelain', '--untracked-files=all', '--', '.',
    ...provisioned.map(file => `:(exclude,literal)${file}`)], item.worktreePath)) return false;
  if (!await ancestor(proof.group.baseTip, baseTip, run.workspaceCwd)) return false;
  const intervening = (await gitExec(['rev-list', '--first-parent', `${proof.group.baseTip}..${baseTip}`], run.workspaceCwd))
    .split('\n').filter(Boolean);
  const landedCommits = new Set<string>();
  const mergedBases: string[] = [];
  for (const id of proof.group.memberItemIds) {
    const member = host.store.getItem(id);
    const memberRun = member ? host.store.getRun(member.runId) : null;
    if (!member || !memberRun || memberRun.status === 'cancelled' || !SAME_ROUND_STATES.has(member.state)
      || pathCompareKey(memberRun.workspaceCwd) !== pathCompareKey(run.workspaceCwd)
      || memberRun.config.baseBranch !== run.config.baseBranch
      || JSON.stringify(memberRun.config.verifierGates) !== JSON.stringify(run.config.verifierGates)) return false;
    const memberProof = member.verdict ? receiptProof(member, memberRun.config.verifierGates) : null;
    if (member.verdict && (!memberProof || memberProof.testedTree !== proof.testedTree
      || JSON.stringify(memberProof.group) !== JSON.stringify(proof.group))) return false;
    if (member.state === 'landed') {
      if (!memberProof || !member.landedCommit) return false;
      if (member.id !== item.id) landedCommits.add(member.landedCommit);
      if (member.checkpointCommit !== memberProof.head) {
        if (!member.checkpointCommit || !await ancestor(memberProof.head, member.checkpointCommit, run.workspaceCwd)) return false;
        const changes = await gitExec(['rev-list', '--first-parent', '--parents', `${memberProof.head}..${member.checkpointCommit}`], run.workspaceCwd);
        for (const change of changes.split('\n').filter(Boolean)) {
          const parents = change.split(' ');
          if (parents.length !== 3) return false;
          mergedBases.push(parents[2]);
        }
      }
    } else if (memberProof && member.checkpointCommit !== memberProof.head) return false;
  }
  return groupRoundStillIntact(proof.group, host)
    && mergedBases.every(commit => commit === proof.group.baseTip || landedCommits.has(commit))
    && intervening.every(commit => landedCommits.has(commit));
}
