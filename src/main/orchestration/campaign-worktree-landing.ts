/**
 * Campaign worktree landing.
 *
 * A campaign with `policy.isolation: 'worktree'` runs every node's loop inside
 * its own AIO-created worktree. When the node's loop ends, that worktree lands
 * back into the node's repository through the same pipeline a managed loop
 * uses (`finalizeLoopWorktree`): harvest → active-plan-document refusal →
 * integration worktree merge → promote → cleanup. A blocked landing keeps the
 * session branch and records the reason on the node's lifecycle.
 *
 * Landings run one at a time, so two nodes finishing together cannot interleave
 * integrate and promote on the shared `integration/<base>` branch (the second
 * integration would move the tip the first promotion is pinned to).
 *
 * After a restart the in-memory WorktreeManager session is gone, so the landing
 * falls back to `reconcileManagedWorktreeLifecycles`, which works from the
 * persisted lifecycle and Git alone.
 *
 * Harvest runs `git add -A` and cleanup removes the checkout, so a landing is
 * refused (and nothing is touched) while the campaign worktree still holds
 * something that is not the node's work product: a nested worktree, or loop
 * runtime state that belongs at the repository root.
 */

import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import type { LoopStatus, LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import type { CampaignNodeRun, CampaignRun } from './campaign.types';
import {
  finalizeLoopWorktree,
  type LoopWorktreeFinalizerManager,
} from './loop-worktree-lifecycle';
import {
  reconcileManagedWorktreeLifecycles,
  type ManagedLifecycleReconcileStore,
  type PendingManagedWorktreeLifecycle,
} from './loop-worktree-lifecycle-reconcile';
import { LOOP_STATE_DIR_NAME } from './loop-artifact-paths';
import { LOOP_CONTROL_DIR_NAME } from './loop-control';
import { awaitLoopWorktreeFinalization } from './loop-worktree-termination-cleanup';
import { getLoopCoordinator } from './loop-coordinator';
import { getLoopStoreService } from './loop-store';
import { getWorktreeManager } from '../workspace/git/worktree-manager';

/** Entries the campaign worktree must not contain when it is harvested. */
const FOREIGN_WORKTREE_ENTRIES = ['.worktrees', LOOP_STATE_DIR_NAME, LOOP_CONTROL_DIR_NAME];

const logger = getLogger('CampaignWorktreeLanding');

export interface CampaignWorktreeLandingManager extends LoopWorktreeFinalizerManager {
  getSession(worktreeId: string): unknown;
}

export interface CampaignWorktreeLandingDeps {
  getManager: () => CampaignWorktreeLandingManager;
  /** Resolve once the node loop's own teardown (and its own worktree landing
   *  into the campaign worktree) has settled. */
  awaitLoopSettled: (loopRunId: string) => Promise<void>;
  reconcile: (store: ManagedLifecycleReconcileStore) => Promise<unknown>;
  /** The node loop's OWN managed-worktree lifecycle, if it ever had one. */
  readLoopWorktreeLifecycle: (loopRunId: string) => LoopWorktreeLifecycle | undefined;
}

/** A halted campaign's node loop that is still alive and owns a worktree. */
export interface CampaignLoopIndexEntry {
  loopRunId: string;
  campaignId: string;
  nodeId: string;
}

/** Production wiring; tests override parts via `setDepsForTesting`. */
export function defaultCampaignLandingDeps(): CampaignWorktreeLandingDeps {
  return {
    getManager: () => getWorktreeManager(),
    awaitLoopSettled: async (loopRunId) => {
      // terminate() registers the loop's own finalization right after it
      // emits the terminal state the campaign coordinator reacts to.
      await Promise.resolve();
      await awaitLoopWorktreeFinalization(loopRunId);
      await getLoopCoordinator().awaitTerminalCleanup(loopRunId);
    },
    reconcile: (store) => reconcileManagedWorktreeLifecycles(store),
    readLoopWorktreeLifecycle: (loopRunId) => {
      try {
        return getLoopStoreService().store.getWorktreeRecord(loopRunId)?.lifecycle;
      } catch {
        return undefined;
      }
    },
  };
}

export type CampaignNodePatcher = (
  campaign: CampaignRun,
  nodeId: string,
  patch: Partial<CampaignNodeRun>,
) => void;

export interface CampaignLandingRequest {
  campaign: CampaignRun;
  nodeId: string;
  /** Absent when the node's loop never started. */
  loopRunId?: string;
  /** The loop's terminal status; decides land (success) versus preserve. */
  loopStatus: LoopStatus;
}

function isSettled(lifecycle: LoopWorktreeLifecycle): boolean {
  return lifecycle.phase === 'cleaned' || lifecycle.phase === 'blocked';
}

function nodeKey(campaignId: string, nodeId: string): string {
  return JSON.stringify([campaignId, nodeId]);
}

export class CampaignWorktreeLanding {
  /** One landing at a time across every campaign. */
  private chain: Promise<unknown> = Promise.resolve();

  /** nodeKey → WorktreeManager session id for worktrees created this process. */
  private readonly sessions = new Map<string, string>();

  constructor(
    private deps: CampaignWorktreeLandingDeps,
    private readonly patchNode: CampaignNodePatcher,
  ) {}

  setDepsForTesting(deps: Partial<CampaignWorktreeLandingDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  rememberSession(campaignId: string, nodeId: string, worktreeSessionId: string): void {
    this.sessions.set(nodeKey(campaignId, nodeId), worktreeSessionId);
  }

  /**
   * The acquisition failed after ownership was recorded: WorktreeManager has
   * already removed the checkout and its branch, so close the record.
   */
  markAcquisitionFailed(campaign: CampaignRun, nodeId: string): void {
    const lifecycle = campaign.nodeRuns.get(nodeId)?.worktreeLifecycle;
    if (!lifecycle || this.sessions.has(nodeKey(campaign.id, nodeId))) return;
    if (isSettled(lifecycle)) return;
    this.patchNode(campaign, nodeId, {
      worktreePath: undefined,
      worktreeLifecycle: {
        ...lifecycle,
        phase: 'cleaned',
        lastError: 'Managed worktree acquisition failed',
        updatedAt: Date.now(),
      },
    });
  }

  /**
   * Land (or preserve) the node's worktree. Resolves with the node's final
   * lifecycle, or `undefined` for a node without a managed worktree — in which
   * case nothing is awaited and nothing is touched.
   */
  async land(request: CampaignLandingRequest): Promise<LoopWorktreeLifecycle | undefined> {
    const { campaign, nodeId } = request;
    const initial = campaign.nodeRuns.get(nodeId)?.worktreeLifecycle;
    if (initial?.managedByAio !== true) return initial;
    if (isSettled(initial)) return initial;

    return this.enqueue(async () => {
      if (request.loopRunId) {
        await this.deps.awaitLoopSettled(request.loopRunId);
      }
      const lifecycle = campaign.nodeRuns.get(nodeId)?.worktreeLifecycle;
      if (!lifecycle || isSettled(lifecycle)) return lifecycle;
      if (await this.refuseForeignContent(campaign, nodeId, request.loopRunId)) {
        return campaign.nodeRuns.get(nodeId)?.worktreeLifecycle;
      }

      const key = nodeKey(campaign.id, nodeId);
      const sessionId = this.sessions.get(key);
      this.sessions.delete(key);
      const manager = this.deps.getManager();
      if (sessionId && manager.getSession(sessionId)) {
        await finalizeLoopWorktree({
          state: { id: key, worktreeLifecycle: lifecycle, config: {} },
          status: request.loopStatus,
          worktreeSessionId: sessionId,
          manager,
          store: {
            updateWorktreeLifecycle: (_id, next) =>
              this.patchNode(campaign, nodeId, { worktreeLifecycle: next }),
            clearWorktreeInfo: () => this.patchNode(campaign, nodeId, { worktreePath: undefined }),
          },
        });
      } else {
        await this.reconcileRows([{ campaign, nodeId, status: request.loopStatus }]);
      }
      const final = campaign.nodeRuns.get(nodeId)?.worktreeLifecycle;
      logger.info('Campaign node worktree landing settled', {
        campaignId: campaign.id,
        nodeId,
        loopStatus: request.loopStatus,
        phase: final?.phase,
        lastError: final?.lastError,
      });
      return final;
    });
  }

  /**
   * Boot recovery: finish every interrupted landing whose loop has ended (or
   * never started). Nodes whose loop is still alive are left for `land()`.
   */
  async reconcileAtBoot(
    campaigns: CampaignRun[],
    endedLoopStatus: (node: CampaignNodeRun) => LoopStatus | null,
  ): Promise<void> {
    const rows: { campaign: CampaignRun; nodeId: string; status: LoopStatus }[] = [];
    for (const campaign of campaigns) {
      for (const [nodeId, node] of campaign.nodeRuns) {
        const lifecycle = node.worktreeLifecycle;
        if (!lifecycle || lifecycle.phase === 'cleaned') continue;
        const status = endedLoopStatus(node);
        if (status) rows.push({ campaign, nodeId, status });
      }
    }
    if (rows.length === 0) return;
    await this.enqueue(async () => {
      const allowed: typeof rows = [];
      for (const row of rows) {
        const loopRunId = row.campaign.nodeRuns.get(row.nodeId)?.loopRunId;
        if (!(await this.refuseForeignContent(row.campaign, row.nodeId, loopRunId))) allowed.push(row);
      }
      await this.reconcileRows(allowed);
    });
  }

  /**
   * Loops of halted (no longer active) campaigns whose worktree is still
   * pending. They must stay indexed so their eventual terminal event lands or
   * preserves the worktree instead of waiting for the next boot.
   */
  haltedLoopsToIndex(campaigns: CampaignRun[], activeIds: ReadonlySet<string>): CampaignLoopIndexEntry[] {
    return campaigns.flatMap((campaign) => activeIds.has(campaign.id) ? [] : [...campaign.nodeRuns]
      .filter(([, node]) => node.loopRunId && node.worktreeLifecycle && !isSettled(node.worktreeLifecycle))
      .map(([nodeId, node]) => ({ loopRunId: node.loopRunId!, campaignId: campaign.id, nodeId })));
  }

  /**
   * Block (touching nothing) when harvesting the campaign worktree would sweep
   * in, or cleanup would delete, something that is not the node's work.
   */
  private async refuseForeignContent(
    campaign: CampaignRun,
    nodeId: string,
    loopRunId: string | undefined,
  ): Promise<boolean> {
    const node = campaign.nodeRuns.get(nodeId);
    const lifecycle = node?.worktreeLifecycle;
    if (!lifecycle) return false;
    let reason: string | null = null;
    const loopWorktree = loopRunId ? this.deps.readLoopWorktreeLifecycle(loopRunId) : undefined;
    if (loopWorktree?.managedByAio === true && loopWorktree.phase !== 'cleaned') {
      reason = `the node loop's own worktree is not cleaned (phase ${loopWorktree.phase}); land it first`;
    } else if (node.worktreePath) {
      const found: string[] = [];
      for (const entry of FOREIGN_WORKTREE_ENTRIES) {
        try {
          if ((await readdir(path.join(node.worktreePath, entry))).length > 0) found.push(`${entry}/`);
        } catch {
          // Absent (or not a directory): nothing to protect.
        }
      }
      if (found.length > 0) {
        reason = `campaign worktree contains ${found.join(', ')} that must not be harvested or deleted; `
          + `the checkout was kept at ${node.worktreePath}`;
      }
    }
    if (!reason) return false;
    logger.warn('Campaign node worktree landing refused', { campaignId: campaign.id, nodeId, reason });
    this.patchNode(campaign, nodeId, {
      worktreeLifecycle: { ...lifecycle, phase: 'blocked', lastError: reason, updatedAt: Date.now() },
    });
    return true;
  }

  private async reconcileRows(
    rows: { campaign: CampaignRun; nodeId: string; status: LoopStatus }[],
  ): Promise<void> {
    const byKey = new Map<string, { campaign: CampaignRun; nodeId: string }>();
    const pending: PendingManagedWorktreeLifecycle[] = [];
    for (const { campaign, nodeId, status } of rows) {
      const node = campaign.nodeRuns.get(nodeId);
      const spec = campaign.spec.nodes.find((candidate) => candidate.id === nodeId);
      if (!node?.worktreeLifecycle || !spec) continue;
      const key = nodeKey(campaign.id, nodeId);
      byKey.set(key, { campaign, nodeId });
      pending.push({
        id: key,
        status,
        workspaceCwd: spec.loopConfig.workspaceCwd,
        worktreePath: node.worktreePath ?? null,
        branchName: node.worktreeLifecycle.sessionBranch,
        autoIntegrateWorktree: true,
        lifecycle: node.worktreeLifecycle,
      });
    }
    if (pending.length === 0) return;
    await this.deps.reconcile({
      getPendingWorktreeLifecycles: () => pending,
      updateWorktreeLifecycle: (id, lifecycle) => {
        const owner = byKey.get(id);
        if (owner) this.patchNode(owner.campaign, owner.nodeId, { worktreeLifecycle: lifecycle });
      },
      clearWorktreeInfo: (id) => {
        const owner = byKey.get(id);
        if (owner) this.patchNode(owner.campaign, owner.nodeId, { worktreePath: undefined });
      },
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/**
 * The campaign pause reason for a successful node whose worktree could not be
 * merged back, or `null` when there is nothing to report.
 */
export function campaignLandingBlockReason(
  nodeId: string,
  lifecycle: LoopWorktreeLifecycle | undefined,
): string | null {
  if (lifecycle?.phase !== 'blocked') return null;
  return `Node ${nodeId} finished but its worktree could not be merged back`
    + ` (${lifecycle.lastError ?? 'unknown reason'}); branch ${lifecycle.sessionBranch}`
    + ' was kept for manual landing';
}
