import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getLoopCoordinator } from './loop-coordinator';
import { getLoopStoreService } from './loop-store';
import { CampaignStore } from './campaign-store';
import type {
  CampaignNode,
  CampaignNodeRun,
  CampaignRun,
  CampaignSpec,
} from './campaign.types';
import { evaluatePredicate, validateCampaignSpec } from './campaign-validation';
import type { LoopStatus, LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import { prepareLoopStartConfig } from './loop-start-config';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import {
  CampaignWorktreeLanding,
  campaignLandingBlockReason,
  defaultCampaignLandingDeps,
} from './campaign-worktree-landing';
import {
  isActiveCampaignNodeStatus,
  isLoopProviderLimited,
  isLoopTerminal,
  loopStatusToNodeStatus,
  normalizeLoopStatusSnapshot,
  type CampaignLoopStatusReaderResult,
  type CampaignLoopStatusSnapshot,
} from './campaign-loop-status';

export { evaluatePredicate, validateCampaignSpec, type CampaignValidationResult } from './campaign-validation';

const logger = getLogger('CampaignCoordinator');
type PreparedCampaignLoopConfig = Awaited<ReturnType<typeof prepareLoopStartConfig>>;
type CampaignLoopStarter = (chatId: string, config: PreparedCampaignLoopConfig) => Promise<{ id: string }>;
type CampaignLoopCanceller = (loopRunId: string) => Promise<boolean>;
type CampaignPreparedWorktree = { worktreePath: string; worktreeSessionId: string };
type CampaignWorktreePreparer = (campaign: CampaignRun, node: CampaignNode) => Promise<CampaignPreparedWorktree>;
type CampaignLoopStatusReader = (loopRunId: string) => CampaignLoopStatusReaderResult;

export class CampaignCoordinator extends EventEmitter {
  private static instance: CampaignCoordinator | null = null;

  private store: CampaignStore | null = null;

  private initialized = false;

  /** In-memory view of active campaigns (non-terminal). */
  private activeCampaigns = new Map<string, CampaignRun>();

  /** loopRunId → { campaignId, nodeId } for O(1) lookup in event handler. */
  private loopRunToNode = new Map<string, { campaignId: string; nodeId: string }>();

  /** IDs of nodes currently starting (guards against double-start). */
  private startingNodes = new Set<string>();

  private loopStarter: CampaignLoopStarter = (chatId, config) => getLoopCoordinator().startLoop(chatId, config);

  private loopCanceller: CampaignLoopCanceller = (loopRunId) => getLoopCoordinator().cancelLoop(loopRunId);

  private loopStatusReader: CampaignLoopStatusReader = (loopRunId) => {
    try {
      const summary = getLoopStoreService().store.getRunSummary(loopRunId);
      return summary ? { status: summary.status, endedAt: summary.endedAt } : null;
    } catch {
      return null;
    }
  };

  private worktreePreparer: CampaignWorktreePreparer = async (campaign, node) => {
    const session = await getWorktreeManager().createWorktree(
      `campaign:${campaign.id}`,
      `${campaign.spec.title} ${node.id}`,
      {
        // T37: campaign nodes verify in their worktree like any other loop.
        repoRoot: node.loopConfig.workspaceCwd,
        // Record ownership before any Git mutation so a restart can finish
        // (or refuse) the merge-back, exactly like a managed loop worktree.
        onPrepared: (candidate) => this.updateNodeRun(campaign, node.id, {
          worktreePath: candidate.worktreePath,
          worktreeLifecycle: {
            managedByAio: true,
            phase: 'acquired',
            baseBranch: candidate.baseBranch,
            sessionBranch: candidate.branchName,
            sessionTip: candidate.baseCommit,
            updatedAt: Date.now(),
          },
        }),
      },
    );
    return { worktreePath: session.worktreePath, worktreeSessionId: session.id };
  };

  /** Merges each isolated node's worktree back when its loop ends. */
  private worktreeLanding = new CampaignWorktreeLanding(
    defaultCampaignLandingDeps(),
    (campaign, nodeId, patch) => this.updateNodeRun(campaign, nodeId, patch),
  );

  static getInstance(): CampaignCoordinator {
    if (!CampaignCoordinator.instance) {
      CampaignCoordinator.instance = new CampaignCoordinator();
    }
    return CampaignCoordinator.instance;
  }

  static _resetForTesting(): void {
    CampaignCoordinator.instance = null;
  }

  setLoopStarterForTesting(starter: CampaignLoopStarter): void {
    this.loopStarter = starter;
  }

  setWorktreePreparerForTesting(preparer: CampaignWorktreePreparer): void {
    this.worktreePreparer = preparer;
  }

  setLoopStatusReaderForTesting(reader: CampaignLoopStatusReader): void {
    this.loopStatusReader = reader;
  }

  setWorktreeLandingDepsForTesting(deps: Parameters<CampaignWorktreeLanding['setDepsForTesting']>[0]): void {
    this.worktreeLanding.setDepsForTesting(deps);
  }

  initialize(): void {
    if (this.initialized) return;
    const svc = getLoopStoreService();
    const db = svc.getDb();
    if (db) {
      this.store = new CampaignStore(db);
    }

    // Subscribe to loop state changes for DAG advancement.
    const coordinator = getLoopCoordinator();
    coordinator.on('loop:provider-limit', ({ loopRunId, willResume }: { loopRunId: string; willResume?: boolean }) => {
      if (willResume) {
        void this.onLoopProviderLimited(loopRunId);
      }
    });
    coordinator.on('loop:state-changed', ({ loopRunId, state }: {
      loopRunId: string;
      state: { status: LoopStatus; endedAt?: number | null };
    }) => {
      if (state.status === 'running') {
        void this.onLoopRunning(loopRunId);
      }
      const snapshot: CampaignLoopStatusSnapshot = {
        status: state.status,
        endedAt: state.endedAt ?? null,
      };
      if (isLoopProviderLimited(snapshot)) {
        void this.onLoopProviderLimited(loopRunId);
      } else if (isLoopTerminal(snapshot)) {
        void this.onLoopTerminal(loopRunId, snapshot.status, snapshot.endedAt);
      }
    });

    this.initialized = true;
    logger.info('CampaignCoordinator initialized');
  }

  /** Call on app boot to re-hydrate campaigns that were interrupted. */
  async recoverInterruptedCampaigns(): Promise<void> {
    if (!this.store) return;
    const active = this.store.listActiveCampaigns();
    await this.recoverNodeWorktrees(active);
    for (const campaign of active) {
      logger.info('Recovering interrupted campaign', { campaignId: campaign.id, status: campaign.status });
      this.activeCampaigns.set(campaign.id, campaign);
      // Re-index any running nodes so loop events route correctly.
      for (const [nodeId, nodeRun] of campaign.nodeRuns) {
        if (!nodeRun.loopRunId) continue;

        const loopSnapshot = normalizeLoopStatusSnapshot(this.loopStatusReader(nodeRun.loopRunId));
        if (loopSnapshot?.status === 'paused' && isActiveCampaignNodeStatus(nodeRun.status)) {
          this.loopRunToNode.set(nodeRun.loopRunId, { campaignId: campaign.id, nodeId });
          campaign.status = 'paused';
          campaign.pausedReason = `Node ${nodeId} loop paused after app restart; resume that loop to continue the campaign`;
          this.store.upsertCampaign(campaign);
          continue;
        }

        if (!loopSnapshot && isActiveCampaignNodeStatus(nodeRun.status)) {
          campaign.status = 'paused';
          campaign.pausedReason = `Node ${nodeId} loop ${nodeRun.loopRunId} is missing after app restart`;
          this.store.upsertCampaign(campaign);
          continue;
        }

        if (loopSnapshot && isLoopProviderLimited(loopSnapshot) && isActiveCampaignNodeStatus(nodeRun.status)) {
          this.loopRunToNode.set(nodeRun.loopRunId, { campaignId: campaign.id, nodeId });
          await this.onLoopProviderLimited(nodeRun.loopRunId);
          continue;
        }

        if (loopSnapshot && isLoopTerminal(loopSnapshot)) {
          this.loopRunToNode.set(nodeRun.loopRunId, { campaignId: campaign.id, nodeId });
          if (isActiveCampaignNodeStatus(nodeRun.status) && this.isCampaignPausedForNode(campaign, nodeId)) {
            campaign.status = 'running';
            campaign.pausedReason = undefined;
            this.store.upsertCampaign(campaign);
          }
          await this.onLoopTerminal(nodeRun.loopRunId, loopSnapshot.status, loopSnapshot.endedAt);
          continue;
        }

        if (nodeRun.status === 'running' || nodeRun.status === 'provider-limit') {
          this.loopRunToNode.set(nodeRun.loopRunId, { campaignId: campaign.id, nodeId });
        }
      }
      // Advance in case a node completed while the app was down.
      await this.advanceCampaign(campaign.id);
    }
  }

  /**
   * Finish node worktree landings interrupted by a restart. Runs after the
   * loop store's own lifecycle reconcile, so a node loop that landed into its
   * campaign worktree has settled first.
   */
  private async recoverNodeWorktrees(active: CampaignRun[]): Promise<void> {
    if (!this.store) return;
    const campaigns = this.store.listCampaignIdsWithPendingWorktrees().flatMap((id) => {
      const campaign = active.find((candidate) => candidate.id === id) ?? this.store?.getCampaign(id);
      return campaign ? [campaign] : [];
    });
    try {
      await this.worktreeLanding.reconcileAtBoot(campaigns, (node) => {
        // A node whose loop never started owns an unused worktree: preserve it.
        if (!node.loopRunId) return isActiveCampaignNodeStatus(node.status) ? null : 'failed';
        const snapshot = normalizeLoopStatusSnapshot(this.loopStatusReader(node.loopRunId));
        return snapshot && isLoopTerminal(snapshot) ? snapshot.status : null;
      });
      const activeIds = new Set(active.map((campaign) => campaign.id));
      for (const entry of this.worktreeLanding.haltedLoopsToIndex(campaigns, activeIds)) {
        this.loopRunToNode.set(entry.loopRunId, { campaignId: entry.campaignId, nodeId: entry.nodeId });
      }
    } catch (err) {
      logger.warn('Campaign worktree recovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async startCampaign(spec: CampaignSpec): Promise<CampaignRun> {
    const validation = validateCampaignSpec(spec);
    if (!validation.valid) {
      throw new Error(`Invalid campaign spec: ${validation.errors.join('; ')}`);
    }

    // Build dependency map from edges.
    const dependsOn = new Map<string, string[]>();
    for (const node of spec.nodes) dependsOn.set(node.id, []);
    for (const edge of spec.edges) dependsOn.get(edge.to)!.push(edge.from);
    for (const node of spec.nodes) {
      node.dependsOn = dependsOn.get(node.id) ?? [];
    }

    const now = Date.now();
    const run: CampaignRun = {
      id: spec.id,
      spec,
      status: 'running',
      nodeRuns: new Map(),
      startedAt: now,
    };

    this.store?.upsertCampaign(run);

    // Initialize all nodes as pending.
    for (const node of spec.nodes) {
      const nodeRun: CampaignNodeRun = {
        nodeId: node.id,
        campaignId: spec.id,
        status: 'pending',
      };
      run.nodeRuns.set(node.id, nodeRun);
      this.store?.upsertNode(nodeRun);
    }

    this.store?.upsertCampaign(run);
    this.activeCampaigns.set(run.id, run);

    logger.info('Campaign started', { campaignId: spec.id, nodeCount: spec.nodes.length });
    this.emit('campaign:started', { campaignId: spec.id });

    await this.advanceCampaign(run.id);
    return run;
  }

  private async advanceCampaign(campaignId: string): Promise<void> {
    const campaign = this.activeCampaigns.get(campaignId);
    if (!campaign) return;
    if (campaign.status !== 'running') return;

    // Count currently running nodes.
    let runningCount = 0;
    for (const nr of campaign.nodeRuns.values()) {
      if (nr.status === 'running') runningCount++;
    }

    const maxParallel = campaign.spec.policy.maxParallel ?? 3;

    // Find all pending nodes whose dependencies are all satisfied.
    for (const node of campaign.spec.nodes) {
      const nodeRun = campaign.nodeRuns.get(node.id);
      if (!nodeRun || nodeRun.status !== 'pending') continue;
      if (runningCount >= maxParallel) break;

      // Step 1: All dependencies must be terminal before this node can be considered.
      const depsTerminal = node.dependsOn.every((depId) => {
        const dep = campaign.nodeRuns.get(depId);
        if (!dep) return false;
        return ['completed', 'completed-needs-review', 'failed', 'operator-halted', 'skipped'].includes(dep.status);
      });

      if (!depsTerminal) continue;

      const skippedDependency = node.dependsOn.find((depId) =>
        campaign.nodeRuns.get(depId)?.status === 'skipped',
      );
      if (skippedDependency) {
        const reason = `Node ${node.id} skipped because dependency ${skippedDependency} was skipped`;
        logger.info('Skipping campaign node (dependency skipped)', { campaignId, nodeId: node.id, reason });
        this.updateNodeRun(campaign, node.id, { status: 'skipped', skippedReason: reason, endedAt: Date.now() });
        this.emit('campaign:node-skipped', { campaignId, nodeId: node.id, reason });
        continue;
      }

      // Step 2: Check whether edge predicates allow this node to start.
      // An edge predicate that fails means the downstream node should be skipped
      // (surfaced explicitly — not silently dropped).
      const allEdgesAllow = node.dependsOn.every((depId) => {
        const dep = campaign.nodeRuns.get(depId);
        if (!dep) return false;
        const edges = campaign.spec.edges.filter((e) => e.from === depId && e.to === node.id);
        if (edges.length === 0) return true;
        return edges.some((edge) => {
          if (!edge.when) return true;
          return evaluatePredicate(dep.status, edge.when);
        });
      });

      if (!allEdgesAllow) {
        // Edge predicate failed — skip this node explicitly so it is surfaced.
        const reason = `Edge predicate not satisfied for node ${node.id}`;
        logger.info('Skipping campaign node (edge predicate failed)', { campaignId, nodeId: node.id, reason });
        this.updateNodeRun(campaign, node.id, { status: 'skipped', skippedReason: reason, endedAt: Date.now() });
        this.emit('campaign:node-skipped', { campaignId, nodeId: node.id, reason });
        continue;
      }

      if (this.startingNodes.has(`${campaignId}:${node.id}`)) continue;
      this.startingNodes.add(`${campaignId}:${node.id}`);
      runningCount++;

      void this.startNode(campaign, node.id).finally(() => {
        this.startingNodes.delete(`${campaignId}:${node.id}`);
      });
    }

    // Check if campaign is complete.
    this.checkCampaignCompletion(campaign);
  }

  private async startNode(campaign: CampaignRun, nodeId: string): Promise<void> {
    const node = campaign.spec.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (!this.isCampaignRunning(campaign)) return;

    let worktreePrepared = false;
    try {
      const chatId = `campaign:${campaign.id}:${nodeId}`;
      let loopConfig = node.loopConfig;
      if (campaign.spec.policy.isolation === 'worktree') {
        const prepared = await this.worktreePreparer(campaign, node);
        this.worktreeLanding.rememberSession(campaign.id, nodeId, prepared.worktreeSessionId);
        worktreePrepared = true;
        // loop-cwd contract: state stays at the repo root (`workspaceCwd`); the
        // agent works in the campaign worktree. A preset `executionCwd` also
        // stops startLoop from nesting its own worktree inside this one.
        loopConfig = { ...node.loopConfig, executionCwd: prepared.worktreePath, isolateLoopWorkspaces: true };
      }
      const preparedConfig = await prepareLoopStartConfig(loopConfig);
      if (!this.isCampaignRunning(campaign)) {
        await this.releaseNodeWorktree(campaign, nodeId, undefined, 'cancelled');
        return;
      }
      const loopState = await this.loopStarter(chatId, preparedConfig);
      // The started loop now owns the worktree; its terminal event releases it.
      worktreePrepared = false;
      if (!this.isCampaignRunning(campaign)) {
        if (await this.cancelLateStartedLoop(loopState.id, campaign, nodeId)) {
          await this.releaseNodeWorktree(campaign, nodeId, loopState.id, 'cancelled');
        }
        return;
      }

      this.loopRunToNode.set(loopState.id, { campaignId: campaign.id, nodeId });
      this.updateNodeRun(campaign, nodeId, {
        status: 'running',
        loopRunId: loopState.id,
        startedAt: Date.now(),
      });

      logger.info('Campaign node started', { campaignId: campaign.id, nodeId, loopRunId: loopState.id });
      this.emit('campaign:node-started', { campaignId: campaign.id, nodeId, loopRunId: loopState.id });
    } catch (err) {
      if (worktreePrepared) {
        await this.releaseNodeWorktree(campaign, nodeId, undefined, 'failed');
      } else {
        this.worktreeLanding.markAcquisitionFailed(campaign, nodeId);
      }
      if (!this.isCampaignRunning(campaign)) return;
      logger.error('Campaign node failed to start', err instanceof Error ? err : new Error(String(err)), { campaignId: campaign.id, nodeId });
      this.updateNodeRun(campaign, nodeId, { status: 'failed', endedAt: Date.now() });
      this.emit('campaign:node-failed', { campaignId: campaign.id, nodeId, error: String(err) });
      this.pauseCampaign(campaign, `Node ${nodeId} failed to start; waiting for operator review`);
    }
  }

  private isCampaignRunning(campaign: CampaignRun): boolean {
    return this.activeCampaigns.get(campaign.id) === campaign && campaign.status === 'running';
  }

  private isCampaignPausedForNode(campaign: CampaignRun, nodeId: string): boolean {
    return campaign.status === 'paused' && campaign.pausedReason?.startsWith(`Node ${nodeId} `) === true;
  }

  /**
   * Land (successful loop) or preserve (anything else) a node's worktree.
   * Returns the settled lifecycle; `undefined` for a non-isolated node.
   */
  private async releaseNodeWorktree(
    campaign: CampaignRun,
    nodeId: string,
    loopRunId: string | undefined,
    loopStatus: LoopStatus,
  ): Promise<LoopWorktreeLifecycle | undefined> {
    try {
      return await this.worktreeLanding.land({ campaign, nodeId, loopRunId, loopStatus });
    } catch (err) {
      logger.warn('Campaign node worktree landing failed', {
        campaignId: campaign.id,
        nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
      return campaign.nodeRuns.get(nodeId)?.worktreeLifecycle;
    }
  }

  private async cancelLateStartedLoop(loopRunId: string, campaign: CampaignRun, nodeId: string): Promise<boolean> {
    try {
      const cancelled = await this.loopCanceller(loopRunId);
      logger.info('Cancelled campaign node loop that started after campaign stopped', {
        campaignId: campaign.id,
        nodeId,
        loopRunId,
        campaignStatus: campaign.status,
      });
      return cancelled;
    } catch (err) {
      logger.warn('Failed to cancel campaign node loop that started after campaign stopped', {
        campaignId: campaign.id,
        nodeId,
        loopRunId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async onLoopProviderLimited(loopRunId: string): Promise<void> {
    const mapping = this.loopRunToNode.get(loopRunId);
    if (!mapping) return;

    const { campaignId, nodeId } = mapping;
    const campaign = this.activeCampaigns.get(campaignId);
    if (!campaign) return;
    const reason = `Node ${nodeId} hit provider limit; waiting for loop auto-resume`;
    const existing = campaign.nodeRuns.get(nodeId);
    if (
      existing?.status === 'provider-limit'
      && campaign.status === 'paused'
      && campaign.pausedReason === reason
    ) {
      return;
    }

    this.updateNodeRun(campaign, nodeId, {
      status: 'provider-limit',
    });

    logger.info('Campaign node parked on provider limit', { campaignId, nodeId, loopRunId });
    this.pauseCampaign(campaign, reason);
  }

  private async onLoopTerminal(loopRunId: string, loopStatus: LoopStatus, endedAt: number | null = null): Promise<void> {
    const mapping = this.loopRunToNode.get(loopRunId);
    if (!mapping) return;

    const { campaignId, nodeId } = mapping;
    const campaign = this.activeCampaigns.get(campaignId);
    const nodeStatus = loopStatusToNodeStatus(loopStatus, endedAt);
    if (!campaign) {
      // A halted campaign's node loop can still end later; its worktree must
      // not be orphaned. Land or preserve it, but do not drive the DAG.
      const halted = nodeStatus === 'provider-limit' ? null : this.store?.getCampaign(campaignId);
      if (halted) {
        this.loopRunToNode.delete(loopRunId);
        await this.releaseNodeWorktree(halted, nodeId, loopRunId, loopStatus);
      }
      return;
    }

    if (nodeStatus === 'provider-limit') {
      await this.onLoopProviderLimited(loopRunId);
      return;
    }

    this.loopRunToNode.delete(loopRunId);
    // Merge the node's worktree back BEFORE it counts as terminal, so its
    // dependants start from a base that already contains its work and the
    // campaign cannot complete while a landing is still in flight.
    const landing = await this.releaseNodeWorktree(campaign, nodeId, loopRunId, loopStatus);
    this.updateNodeRun(campaign, nodeId, {
      status: nodeStatus,
      endedAt: Date.now(),
    });

    logger.info('Campaign node reached terminal', { campaignId, nodeId, nodeStatus, loopRunId });
    this.emit('campaign:node-terminal', { campaignId, nodeId, status: nodeStatus });
    if (this.activeCampaigns.get(campaignId) !== campaign) return;

    const landingBlock = nodeStatus === 'completed' || nodeStatus === 'completed-needs-review'
      ? campaignLandingBlockReason(nodeId, landing)
      : null;
    if (landingBlock && nodeStatus === 'completed-needs-review' && campaign.spec.policy.onNodeNeedsReview === 'halt') {
      this.markCampaignHalted(campaign, `Node ${nodeId} reached completed-needs-review (policy: halt); ${landingBlock}`);
      return;
    }
    if (landingBlock) {
      this.pauseCampaign(campaign, landingBlock);
      return;
    }

    // Handle needs-review per policy.
    if (nodeStatus === 'completed-needs-review') {
      const onNeedsReview = campaign.spec.policy.onNodeNeedsReview;
      if (onNeedsReview === 'pause-campaign') {
        this.pauseCampaign(campaign, `Node ${nodeId} reached completed-needs-review`);
        return;
      } else if (onNeedsReview === 'halt') {
        this.markCampaignHalted(campaign, `Node ${nodeId} reached completed-needs-review (policy: halt)`);
        return;
      }
      // 'continue' — fall through to advance.
    }

    if (nodeStatus === 'failed') {
      this.pauseCampaign(campaign, `Node ${nodeId} failed; waiting for operator review`);
      return;
    }

    if (nodeStatus === 'operator-halted') {
      this.markCampaignHalted(campaign, `Node ${nodeId} was cancelled by the operator`);
      return;
    }

    await this.advanceCampaign(campaignId);
  }

  private async onLoopRunning(loopRunId: string): Promise<void> {
    const mapping = this.loopRunToNode.get(loopRunId);
    if (!mapping) return;

    const { campaignId, nodeId } = mapping;
    const campaign = this.activeCampaigns.get(campaignId);
    if (!campaign) return;

    const nodeRun = campaign.nodeRuns.get(nodeId);
    if (
      campaign.status !== 'paused'
      || !nodeRun
      || (nodeRun.status !== 'provider-limit' && nodeRun.status !== 'running')
      || !this.isCampaignPausedForNode(campaign, nodeId)
    ) {
      return;
    }

    campaign.status = 'running';
    campaign.pausedReason = undefined;
    this.updateNodeRun(campaign, nodeId, { status: 'running' });
    this.store?.upsertCampaign(campaign);
    logger.info('Campaign resumed after paused node loop resumed', { campaignId, nodeId, loopRunId });
    this.emit('campaign:resumed', { campaignId });
    await this.advanceCampaign(campaignId);
  }

  private pauseCampaign(campaign: CampaignRun, reason: string): void {
    campaign.status = 'paused';
    campaign.pausedReason = reason;
    this.store?.upsertCampaign(campaign);
    logger.info('Campaign paused', { campaignId: campaign.id, reason });
    this.emit('campaign:paused', { campaignId: campaign.id, reason });
  }

  /** Resume a paused campaign (operator accepted the needs-review node). */
  async resumeCampaign(campaignId: string): Promise<void> {
    const campaign = this.activeCampaigns.get(campaignId);
    if (!campaign || campaign.status !== 'paused') return;
    campaign.status = 'running';
    campaign.pausedReason = undefined;
    this.store?.upsertCampaign(campaign);
    logger.info('Campaign resumed', { campaignId });
    this.emit('campaign:resumed', { campaignId });
    await this.advanceCampaign(campaignId);
  }

  /** Operator manually stops a campaign. */
  haltCampaignByOperator(campaignId: string): void {
    const campaign = this.activeCampaigns.get(campaignId);
    if (!campaign) return;
    this.markCampaignHalted(campaign, 'campaign halted by operator');
  }

  private markCampaignHalted(campaign: CampaignRun, reason: string): void {
    campaign.status = 'halted';
    campaign.endedAt = Date.now();
    this.activeCampaigns.delete(campaign.id);
    this.store?.upsertCampaign(campaign);
    logger.info('Campaign halted', { campaignId: campaign.id, reason });
    this.emit('campaign:halted', { campaignId: campaign.id, reason });
  }

  private checkCampaignCompletion(campaign: CampaignRun): void {
    if (campaign.status !== 'running') return;
    const allTerminal = [...campaign.nodeRuns.values()].every((nr) =>
      ['completed', 'completed-needs-review', 'failed', 'skipped', 'operator-halted'].includes(nr.status),
    );
    if (!allTerminal) return;
    const anyFailed = [...campaign.nodeRuns.values()].some((nr) =>
      nr.status === 'failed',
    );
    campaign.status = anyFailed ? 'failed' : 'completed';
    campaign.endedAt = Date.now();
    this.activeCampaigns.delete(campaign.id);
    this.store?.upsertCampaign(campaign);
    logger.info('Campaign completed', { campaignId: campaign.id, status: campaign.status });
    this.emit(`campaign:${campaign.status}`, { campaignId: campaign.id });
  }

  private updateNodeRun(campaign: CampaignRun, nodeId: string, patch: Partial<CampaignNodeRun>): void {
    const existing = campaign.nodeRuns.get(nodeId);
    if (!existing) return;
    const updated: CampaignNodeRun = { ...existing, ...patch };
    campaign.nodeRuns.set(nodeId, updated);
    this.store?.upsertNode(updated);
    this.store?.upsertCampaign(campaign);
    this.emit('campaign:state-changed', {
      campaignId: campaign.id,
      nodeId,
      nodeStatus: updated.status,
      campaignStatus: campaign.status,
    });
  }

  getCampaign(campaignId: string): CampaignRun | null {
    return this.activeCampaigns.get(campaignId) ?? this.store?.getCampaign(campaignId) ?? null;
  }

  listCampaigns(limit?: number): CampaignRun[] {
    return this.store?.listAllCampaigns(limit) ?? [];
  }
}

let coordinator: CampaignCoordinator | null = null;

export function getCampaignCoordinator(): CampaignCoordinator {
  if (!coordinator) coordinator = CampaignCoordinator.getInstance();
  return coordinator;
}

export function _resetCampaignCoordinatorForTesting(): void {
  coordinator = null;
  CampaignCoordinator._resetForTesting();
}
