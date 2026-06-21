import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getLoopCoordinator } from './loop-coordinator';
import { getLoopStoreService } from './loop-store';
import { CampaignStore } from './campaign-store';
import type {
  CampaignNode,
  CampaignNodeRun,
  CampaignNodeStatus,
  CampaignRun,
  CampaignSpec,
  CampaignStatus,
  TerminalStatusPredicate,
} from './campaign.types';
import type { LoopStatus } from '../../shared/types/loop.types';
import { prepareLoopStartConfig } from './loop-start-config';
import { getWorktreeManager } from '../workspace/git/worktree-manager';

const logger = getLogger('CampaignCoordinator');
type PreparedCampaignLoopConfig = Awaited<ReturnType<typeof prepareLoopStartConfig>>;
type CampaignLoopStarter = (chatId: string, config: PreparedCampaignLoopConfig) => Promise<{ id: string }>;
type CampaignLoopCanceller = (loopRunId: string) => Promise<boolean>;
type CampaignWorktreePreparer = (campaign: CampaignRun, node: CampaignNode) => Promise<string>;
type CampaignLoopStatusReader = (loopRunId: string) => LoopStatus | null;
const CAMPAIGN_PREDICATE_STATUSES = new Set<string>([
  'completed',
  'completed-needs-review',
  'failed',
  'provider-limit',
  'operator-halted',
]);

/** Terminal LoopStatus values. */
const LOOP_TERMINAL_STATUSES = new Set<LoopStatus>([
  'completed',
  'completed-needs-review',
  'cancelled',
  'failed',
  'error',
  'no-progress',
  'cap-reached',
  'provider-limit',
  // Ping-pong terminal states (bigchange_pingpong_review §4.11).
  'cost-exceeded',
  'needs-human-arbitration',
  'reviewer-unreliable',
  'reviewer-unavailable',
  'builder-unreliable',
]);

function isLoopTerminal(status: LoopStatus): boolean {
  return LOOP_TERMINAL_STATUSES.has(status);
}

/** Node statuses that imply an in-flight loop the campaign is waiting on. */
function isActiveCampaignNodeStatus(status: CampaignNodeStatus): boolean {
  return status === 'running' || status === 'provider-limit';
}

/** Map a LoopStatus to a CampaignNodeStatus. */
function loopStatusToNodeStatus(ls: LoopStatus): CampaignNodeStatus {
  switch (ls) {
    case 'completed': return 'completed';
    case 'completed-needs-review': return 'completed-needs-review';
    case 'failed':
    case 'error':
    case 'no-progress':
    case 'cap-reached':
    // Ping-pong non-converged terminals map to a failed campaign node so the
    // campaign treats "didn't converge" uniformly; arbitration/unreliable are
    // surfaced in the loop UI, not the campaign graph.
    case 'cost-exceeded':
    case 'needs-human-arbitration':
    case 'reviewer-unreliable':
    case 'reviewer-unavailable':
    case 'builder-unreliable': return 'failed';
    case 'provider-limit': return 'provider-limit';
    case 'cancelled': return 'operator-halted';
    default: return 'failed';
  }
}

/** Evaluate a TerminalStatusPredicate against a CampaignNodeStatus. Exported for unit testing. */
export function evaluatePredicate(status: CampaignNodeStatus, predicate: TerminalStatusPredicate): boolean {
  switch (predicate.type) {
    case 'is': return status === predicate.status;
    case 'in': return (predicate.statuses as string[]).includes(status);
    case 'not': return status !== predicate.status;
  }
}

export interface CampaignValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a CampaignSpec: check IDs are unique, edges reference existing nodes, graph is acyclic. */
export function validateCampaignSpec(spec: CampaignSpec): CampaignValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  if (!spec.nodes.length) errors.push('Campaign must have at least one node');
  if (!Number.isInteger(spec.policy.maxParallel) || spec.policy.maxParallel < 1 || spec.policy.maxParallel > 16) {
    errors.push('Campaign policy maxParallel must be an integer from 1 to 16');
  }
  if (!['pause-campaign', 'continue', 'halt'].includes(spec.policy.onNodeNeedsReview)) {
    errors.push('Campaign policy onNodeNeedsReview is invalid');
  }

  for (const node of spec.nodes) {
    if (!node.id) errors.push('Every node must have an id');
    if (nodeIds.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }

  for (const edge of spec.edges) {
    if (!nodeIds.has(edge.from)) errors.push(`Edge references unknown source node: ${edge.from}`);
    if (!nodeIds.has(edge.to)) errors.push(`Edge references unknown target node: ${edge.to}`);
    if (edge.from === edge.to) errors.push(`Self-loop on node: ${edge.from}`);
    if (edge.when) validateEdgePredicate(edge.from, edge.to, edge.when, errors);
  }

  if (errors.length === 0 && hasCycle(spec)) {
    errors.push('Campaign DAG contains a cycle');
  }

  return { valid: errors.length === 0, errors };
}

function validateEdgePredicate(
  from: string,
  to: string,
  predicate: TerminalStatusPredicate,
  errors: string[],
): void {
  if (predicate.type === 'in') {
    if (predicate.statuses.length === 0) {
      errors.push(`Edge ${from}->${to} predicate must include at least one status`);
      return;
    }
    for (const status of predicate.statuses) {
      if (!CAMPAIGN_PREDICATE_STATUSES.has(status)) {
        errors.push(`Edge ${from}->${to} predicate status is invalid: ${status}`);
      }
    }
    return;
  }

  if (!CAMPAIGN_PREDICATE_STATUSES.has(predicate.status)) {
    errors.push(`Edge ${from}->${to} predicate status is invalid: ${predicate.status}`);
  }
}

function hasCycle(spec: CampaignSpec): boolean {
  const adj = new Map<string, string[]>();
  for (const node of spec.nodes) adj.set(node.id, []);
  for (const edge of spec.edges) adj.get(edge.from)!.push(edge.to);

  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of spec.nodes) color.set(node.id, WHITE);

  function dfs(id: string): boolean {
    color.set(id, GREY);
    for (const neighbor of adj.get(id) ?? []) {
      if (color.get(neighbor) === GREY) return true;
      if (color.get(neighbor) === WHITE && dfs(neighbor)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const node of spec.nodes) {
    if (color.get(node.id) === WHITE && dfs(node.id)) return true;
  }
  return false;
}

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
      return getLoopStoreService().store.getRunSummary(loopRunId)?.status ?? null;
    } catch {
      return null;
    }
  };

  private worktreePreparer: CampaignWorktreePreparer = async (campaign, node) => {
    const session = await getWorktreeManager().createWorktree(
      `campaign:${campaign.id}`,
      `${campaign.spec.title} ${node.id}`,
      {
        repoRoot: node.loopConfig.workspaceCwd,
        skipInstall: true,
      },
    );
    return session.worktreePath;
  };

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

  initialize(): void {
    if (this.initialized) return;
    const svc = getLoopStoreService();
    const db = svc.getDb();
    if (db) {
      this.store = new CampaignStore(db);
    }

    // Subscribe to loop state changes for DAG advancement.
    const coordinator = getLoopCoordinator();
    coordinator.on('loop:state-changed', ({ loopRunId, state }: { loopRunId: string; state: { status: LoopStatus } }) => {
      if (state.status === 'running') {
        void this.onLoopRunning(loopRunId);
      }
      if (isLoopTerminal(state.status)) {
        void this.onLoopTerminal(loopRunId, state.status);
      }
    });

    this.initialized = true;
    logger.info('CampaignCoordinator initialized');
  }

  /** Call on app boot to re-hydrate campaigns that were interrupted. */
  async recoverInterruptedCampaigns(): Promise<void> {
    if (!this.store) return;
    const active = this.store.listActiveCampaigns();
    for (const campaign of active) {
      logger.info('Recovering interrupted campaign', { campaignId: campaign.id, status: campaign.status });
      this.activeCampaigns.set(campaign.id, campaign);
      // Re-index any running nodes so loop events route correctly.
      for (const [nodeId, nodeRun] of campaign.nodeRuns) {
        if (!nodeRun.loopRunId) continue;

        const loopStatus = this.loopStatusReader(nodeRun.loopRunId);
        if (loopStatus === 'paused' && isActiveCampaignNodeStatus(nodeRun.status)) {
          this.loopRunToNode.set(nodeRun.loopRunId, { campaignId: campaign.id, nodeId });
          campaign.status = 'paused';
          campaign.pausedReason = `Node ${nodeId} loop paused after app restart; resume that loop to continue the campaign`;
          this.store.upsertCampaign(campaign);
          continue;
        }

        if (!loopStatus && isActiveCampaignNodeStatus(nodeRun.status)) {
          campaign.status = 'paused';
          campaign.pausedReason = `Node ${nodeId} loop ${nodeRun.loopRunId} is missing after app restart`;
          this.store.upsertCampaign(campaign);
          continue;
        }

        if (loopStatus && isLoopTerminal(loopStatus)) {
          this.loopRunToNode.set(nodeRun.loopRunId, { campaignId: campaign.id, nodeId });
          if (isActiveCampaignNodeStatus(nodeRun.status) && this.isCampaignPausedForNode(campaign, nodeId)) {
            campaign.status = 'running';
            campaign.pausedReason = undefined;
            this.store.upsertCampaign(campaign);
          }
          await this.onLoopTerminal(nodeRun.loopRunId, loopStatus);
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

    try {
      const chatId = `campaign:${campaign.id}:${nodeId}`;
      const loopConfig = campaign.spec.policy.isolation === 'worktree'
        ? { ...node.loopConfig, workspaceCwd: await this.worktreePreparer(campaign, node) }
        : node.loopConfig;
      const preparedConfig = await prepareLoopStartConfig(loopConfig);
      if (!this.isCampaignRunning(campaign)) return;
      const loopState = await this.loopStarter(chatId, preparedConfig);
      if (!this.isCampaignRunning(campaign)) {
        await this.cancelLateStartedLoop(loopState.id, campaign, nodeId);
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

  private async cancelLateStartedLoop(loopRunId: string, campaign: CampaignRun, nodeId: string): Promise<void> {
    try {
      await this.loopCanceller(loopRunId);
      logger.info('Cancelled campaign node loop that started after campaign stopped', {
        campaignId: campaign.id,
        nodeId,
        loopRunId,
        campaignStatus: campaign.status,
      });
    } catch (err) {
      logger.warn('Failed to cancel campaign node loop that started after campaign stopped', {
        campaignId: campaign.id,
        nodeId,
        loopRunId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async onLoopTerminal(loopRunId: string, loopStatus: LoopStatus): Promise<void> {
    const mapping = this.loopRunToNode.get(loopRunId);
    if (!mapping) return;

    const { campaignId, nodeId } = mapping;
    if (loopStatus !== 'provider-limit') {
      this.loopRunToNode.delete(loopRunId);
    }

    const campaign = this.activeCampaigns.get(campaignId);
    if (!campaign) return;

    const nodeStatus = loopStatusToNodeStatus(loopStatus);
    this.updateNodeRun(campaign, nodeId, {
      status: nodeStatus,
      ...(nodeStatus === 'provider-limit' ? {} : { endedAt: Date.now() }),
    });

    logger.info('Campaign node reached terminal', { campaignId, nodeId, nodeStatus, loopRunId });
    this.emit('campaign:node-terminal', { campaignId, nodeId, status: nodeStatus });

    if (nodeStatus === 'provider-limit') {
      this.pauseCampaign(campaign, `Node ${nodeId} hit provider limit; waiting for loop auto-resume`);
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
