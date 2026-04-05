/**
 * Reaction Engine — Monitors CI/PR state and routes feedback to agent instances.
 *
 * Inspired by Agent Orchestrator's lifecycle-manager.ts, adapted for
 * AI Orchestrator's Electron + instance-manager architecture.
 *
 * Polling loop:
 *   1. Collect all instances with tracked PRs
 *   2. Batch-fetch PR enrichment data (CI, reviews, merge state)
 *   3. Detect state transitions per instance
 *   4. Execute reactions (send-to-agent, notify, auto-merge)
 *   5. Handle escalation when retries are exhausted
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import { fetchPREnrichmentBatch, formatCIFailureMessage, formatReviewMessage } from '../vcs/remotes/github-pr-poller';
import { parseGitHostWorkItemUrl } from '../vcs/remotes/git-host-connector';
import type { InstanceManager } from '../instance/instance-manager';
import type {
  ReactionEngineConfig,
  ReactionConfig,
  ReactionEvent,
  ReactionEventType,
  ReactionEventPriority,
  ReactionResult,
  InstanceReactionState,
  ReactionTracker,
  PREnrichmentData,
} from '../../shared/types/reaction.types';
import {
  DEFAULT_REACTION_ENGINE_CONFIG,
  eventToReactionKey,
  inferReactionPriority,
  parseDuration,
} from '../../shared/types/reaction.types';

const logger = getLogger('ReactionEngine');

export class ReactionEngine extends EventEmitter {
  private static instance: ReactionEngine | null = null;

  private config: ReactionEngineConfig = { ...DEFAULT_REACTION_ENGINE_CONFIG };
  private instanceManager: InstanceManager | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  /** Reaction state tracked per instance */
  private trackedInstances = new Map<string, InstanceReactionState>();

  static getInstance(): ReactionEngine {
    if (!ReactionEngine.instance) {
      ReactionEngine.instance = new ReactionEngine();
    }
    return ReactionEngine.instance;
  }

  static _resetForTesting(): void {
    ReactionEngine.instance?.stop();
    ReactionEngine.instance = null;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  initialize(instanceManager: InstanceManager, config?: Partial<ReactionEngineConfig>): void {
    this.instanceManager = instanceManager;

    if (config) {
      this.config = {
        ...DEFAULT_REACTION_ENGINE_CONFIG,
        ...config,
        reactions: { ...DEFAULT_REACTION_ENGINE_CONFIG.reactions, ...config.reactions },
        notificationRouting: { ...DEFAULT_REACTION_ENGINE_CONFIG.notificationRouting, ...config.notificationRouting },
      };
    }

    // Listen for instance removal to clean up tracking
    instanceManager.on('instance:removed', (instanceId: string) => {
      this.untrackInstance(instanceId);
    });

    logger.info('Reaction engine initialized', {
      enabled: this.config.enabled,
      pollIntervalMs: this.config.pollIntervalMs,
      trackedReactions: Object.keys(this.config.reactions).length,
    });
  }

  // -------------------------------------------------------------------------
  // Start / Stop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.pollTimer) return;
    if (!this.config.enabled) {
      logger.info('Reaction engine is disabled');
      return;
    }

    logger.info('Starting reaction engine', { pollIntervalMs: this.config.pollIntervalMs });

    // Run first poll immediately, then on interval
    void this.pollAll();
    this.pollTimer = setInterval(() => void this.pollAll(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Reaction engine stopped');
  }

  isRunning(): boolean {
    return this.pollTimer !== null;
  }

  // -------------------------------------------------------------------------
  // Instance Tracking
  // -------------------------------------------------------------------------

  /**
   * Start tracking a PR for an instance. Called when an instance
   * is associated with a PR (e.g., from a repo-job or user command).
   */
  trackInstance(instanceId: string, prUrl: string): void {
    const existing = this.trackedInstances.get(instanceId);
    if (existing?.prUrl === prUrl) return;

    this.trackedInstances.set(instanceId, {
      instanceId,
      prUrl,
      reactionTrackers: new Map(),
      startedAt: Date.now(),
    });

    logger.info('Tracking instance for reactions', { instanceId, prUrl });
    this.emit('reaction:tracking-started', { instanceId, prUrl });

    // Auto-start engine if not running
    if (!this.pollTimer && this.config.enabled) {
      this.start();
    }
  }

  /** Stop tracking an instance */
  untrackInstance(instanceId: string): void {
    if (this.trackedInstances.delete(instanceId)) {
      logger.info('Untracked instance from reactions', { instanceId });
      this.emit('reaction:tracking-stopped', { instanceId });
    }

    // Auto-stop if no tracked instances remain
    if (this.trackedInstances.size === 0 && this.pollTimer) {
      this.stop();
    }
  }

  /** Get tracking state for an instance */
  getTrackingState(instanceId: string): InstanceReactionState | undefined {
    return this.trackedInstances.get(instanceId);
  }

  /** Get all tracked instances */
  getTrackedInstances(): InstanceReactionState[] {
    return [...this.trackedInstances.values()];
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  updateConfig(config: Partial<ReactionEngineConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = {
      ...this.config,
      ...config,
      reactions: { ...this.config.reactions, ...config.reactions },
      notificationRouting: { ...this.config.notificationRouting, ...config.notificationRouting },
    };

    if (this.config.enabled && !wasEnabled) {
      this.start();
    } else if (!this.config.enabled && wasEnabled) {
      this.stop();
    }
  }

  getConfig(): Readonly<ReactionEngineConfig> {
    return this.config;
  }

  // -------------------------------------------------------------------------
  // Core Polling Loop
  // -------------------------------------------------------------------------

  private async pollAll(): Promise<void> {
    if (this.polling) return; // Re-entrancy guard
    this.polling = true;

    try {
      const tracked = [...this.trackedInstances.values()];
      if (tracked.length === 0) {
        return;
      }

      // Collect PRs to poll
      const prsToFetch: { owner: string; repo: string; number: number; instanceId: string }[] = [];
      for (const state of tracked) {
        if (!state.prUrl) continue;
        const ref = parseGitHostWorkItemUrl(state.prUrl);
        if (!ref || ref.provider !== 'github' || !ref.owner) continue;
        prsToFetch.push({
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          instanceId: state.instanceId,
        });
      }

      if (prsToFetch.length === 0) return;

      // Batch-fetch PR enrichment data
      const enrichmentData = await fetchPREnrichmentBatch(
        prsToFetch.map(({ owner, repo, number }) => ({ owner, repo, number })),
      );

      // Process each tracked instance
      for (const pr of prsToFetch) {
        const key = `${pr.owner}/${pr.repo}#${pr.number}`;
        const enrichment = enrichmentData.get(key);
        if (!enrichment) continue;

        const state = this.trackedInstances.get(pr.instanceId);
        if (!state) continue;

        await this.processInstanceTransitions(state, enrichment);

        // Update cached state
        state.prData = enrichment;
        state.lastPolledAt = Date.now();
      }
    } catch (err) {
      logger.error('Reaction engine poll failed', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.polling = false;
    }
  }

  // -------------------------------------------------------------------------
  // State Transition Detection
  // -------------------------------------------------------------------------

  private async processInstanceTransitions(
    state: InstanceReactionState,
    data: PREnrichmentData,
  ): Promise<void> {
    // Detect CI status change
    if (state.lastCIStatus !== data.ciStatus) {
      const oldCI = state.lastCIStatus;
      state.lastCIStatus = data.ciStatus;

      if (oldCI !== undefined) { // Skip first poll
        await this.handleCITransition(state, data);
      }
    }

    // Detect review decision change
    if (state.lastReviewDecision !== data.reviewDecision) {
      const oldReview = state.lastReviewDecision;
      state.lastReviewDecision = data.reviewDecision;

      if (oldReview !== undefined) {
        await this.handleReviewTransition(state, data);
      }
    }

    // Detect PR state change (merged, closed)
    const prStatus = `${data.state}:${data.mergeable}:${data.hasConflicts}`;
    if (state.lastPRStatus !== prStatus) {
      const oldPRStatus = state.lastPRStatus;
      state.lastPRStatus = prStatus;

      if (oldPRStatus !== undefined) {
        await this.handlePRStateTransition(state, data);
      }
    }

    // Check for merge conflicts
    if (data.hasConflicts) {
      await this.handleMergeConflicts(state, data);
    }

    // Check for merge-ready state
    if (data.state === 'open' && data.ciStatus === 'passing' && data.reviewDecision === 'approved' && data.mergeable) {
      await this.triggerReaction(state, 'merge.ready', data, 'PR is approved with passing CI and ready to merge.');
    }
  }

  private async handleCITransition(state: InstanceReactionState, data: PREnrichmentData): Promise<void> {
    if (data.ciStatus === 'failing') {
      const message = formatCIFailureMessage(data.ciChecks);
      await this.triggerReaction(state, 'ci.failing', data, message);
    } else if (data.ciStatus === 'passing') {
      // Don't clear the tracker — escalation should accumulate across
      // fail/recover cycles. Trackers are only cleared on PR merge/close.
      this.emitEvent(state, 'ci.passing', data, 'CI checks are now passing.');
    }
  }

  private async handleReviewTransition(state: InstanceReactionState, data: PREnrichmentData): Promise<void> {
    if (data.reviewDecision === 'changes_requested') {
      const message = formatReviewMessage(data.reviewDecision);
      await this.triggerReaction(state, 'review.changes_requested', data, message);
    } else if (data.reviewDecision === 'approved') {
      // Don't clear the tracker — see comment in handleCITransition.
      this.emitEvent(state, 'review.approved', data, 'PR has been approved.');
    }
  }

  private async handlePRStateTransition(state: InstanceReactionState, data: PREnrichmentData): Promise<void> {
    if (data.state === 'merged') {
      this.emitEvent(state, 'pr.merged', data, 'PR has been merged.');
      await this.triggerReaction(state, 'merge.completed', data, 'PR has been merged. You can clean up the worktree.');
    } else if (data.state === 'closed') {
      this.emitEvent(state, 'pr.closed', data, 'PR has been closed without merging.');
    }
  }

  private async handleMergeConflicts(state: InstanceReactionState, data: PREnrichmentData): Promise<void> {
    // Only dispatch once per conflict cycle
    const fingerprint = `conflicts:${data.updatedAt}`;
    if (state.lastCIFailureFingerprint === fingerprint) return;
    state.lastCIFailureFingerprint = fingerprint;

    await this.triggerReaction(state, 'merge.conflicts', data,
      'This PR has merge conflicts. Please resolve them by rebasing or merging the base branch.');
  }

  // -------------------------------------------------------------------------
  // Reaction Execution
  // -------------------------------------------------------------------------

  private async triggerReaction(
    state: InstanceReactionState,
    eventType: ReactionEventType,
    data: PREnrichmentData,
    message: string,
  ): Promise<ReactionResult | null> {
    const reactionKey = eventToReactionKey(eventType);
    if (!reactionKey) return null;

    const reactionConfig = this.config.reactions[reactionKey];
    if (!reactionConfig || !reactionConfig.auto) return null;

    // Check escalation
    const tracker = this.getOrCreateTracker(state, reactionKey);
    tracker.attempts++;
    tracker.lastTriggered = Date.now();

    if (this.shouldEscalate(tracker, reactionConfig)) {
      const escalationEvent = this.emitEvent(state, eventType, data, message);
      this.emit('reaction:escalated', escalationEvent);
      await this.notifyHuman(escalationEvent, 'urgent');
      return { reactionType: reactionKey, success: true, action: 'escalated', escalated: true };
    }

    // Execute the reaction action
    return this.executeAction(state, eventType, reactionConfig, data, message);
  }

  private async executeAction(
    state: InstanceReactionState,
    eventType: ReactionEventType,
    config: ReactionConfig,
    data: PREnrichmentData,
    message: string,
  ): Promise<ReactionResult> {
    const reactionKey = eventToReactionKey(eventType) ?? eventType;
    const priority = config.priority ?? inferReactionPriority(eventType);

    switch (config.action) {
      case 'send-to-agent': {
        const sent = await this.sendToAgent(state.instanceId, config.message ?? message);
        const event = this.emitEvent(state, eventType, data, message);
        if (!sent) {
          this.emit('reaction:send-failed', event);
        }
        return { reactionType: reactionKey, success: sent, action: 'send-to-agent', message, escalated: false };
      }

      case 'notify': {
        const event = this.emitEvent(state, eventType, data, message);
        await this.notifyHuman(event, priority);
        return { reactionType: reactionKey, success: true, action: 'notify', message, escalated: false };
      }

      case 'auto-merge': {
        // Placeholder: auto-merge not yet implemented, fall back to notify
        const event = this.emitEvent(state, eventType, data, message);
        await this.notifyHuman(event, priority);
        return { reactionType: reactionKey, success: true, action: 'auto-merge', message, escalated: false };
      }

      case 'ignore':
      default:
        return { reactionType: reactionKey, success: true, action: 'ignore', escalated: false };
    }
  }

  // -------------------------------------------------------------------------
  // Agent Communication
  // -------------------------------------------------------------------------

  private async sendToAgent(instanceId: string, message: string): Promise<boolean> {
    if (!this.instanceManager) return false;

    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance || instance.status === 'terminated' || instance.status === 'error') {
      logger.warn('Cannot send reaction to terminated/errored instance', { instanceId });
      return false;
    }

    try {
      await this.instanceManager.sendInput(instanceId, message);
      logger.info('Sent reaction feedback to agent', {
        instanceId,
        messagePreview: message.slice(0, 120),
      });
      return true;
    } catch (err) {
      logger.error('Failed to send reaction to agent', err instanceof Error ? err : new Error(String(err)), { instanceId });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Notification
  // -------------------------------------------------------------------------

  private async notifyHuman(event: ReactionEvent, priority: ReactionEventPriority): Promise<void> {
    // Emit for any listeners (UI, channels, etc.)
    this.emit('reaction:notify', { event, priority });

    // Route to configured notification channels
    const channels = this.config.notificationRouting[priority] ?? ['desktop'];
    this.emit('reaction:notify-channels', { event, priority, channels });
  }

  // -------------------------------------------------------------------------
  // Escalation Logic
  // -------------------------------------------------------------------------

  private getOrCreateTracker(state: InstanceReactionState, reactionKey: string): ReactionTracker {
    let tracker = state.reactionTrackers.get(reactionKey);
    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: Date.now(), lastTriggered: Date.now() };
      state.reactionTrackers.set(reactionKey, tracker);
    }
    return tracker;
  }

  private shouldEscalate(tracker: ReactionTracker, config: ReactionConfig): boolean {
    // Check retry count
    if (config.retries !== undefined && tracker.attempts > config.retries) {
      return true;
    }

    // Check time-based escalation
    if (config.escalateAfter !== undefined) {
      if (typeof config.escalateAfter === 'string') {
        const thresholdMs = parseDuration(config.escalateAfter);
        if (thresholdMs > 0 && Date.now() - tracker.firstTriggered > thresholdMs) {
          return true;
        }
      } else if (typeof config.escalateAfter === 'number') {
        if (tracker.attempts > config.escalateAfter) {
          return true;
        }
      }
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Event Helpers
  // -------------------------------------------------------------------------

  private emitEvent(
    state: InstanceReactionState,
    eventType: ReactionEventType,
    data: PREnrichmentData,
    message: string,
  ): ReactionEvent {
    const event: ReactionEvent = {
      id: generateId(),
      type: eventType,
      priority: inferReactionPriority(eventType),
      instanceId: state.instanceId,
      timestamp: Date.now(),
      data: {
        prUrl: state.prUrl,
        ciStatus: data.ciStatus,
        reviewDecision: data.reviewDecision,
        prState: data.state,
        mergeable: data.mergeable,
        hasConflicts: data.hasConflicts,
      },
      message,
    };

    this.emit('reaction:event', event);
    return event;
  }
}

// Convenience singleton accessor
let engine: ReactionEngine | null = null;
export function getReactionEngine(): ReactionEngine {
  if (!engine) engine = ReactionEngine.getInstance();
  return engine;
}

export function _resetReactionEngineForTesting(): void {
  engine = null;
  ReactionEngine._resetForTesting();
}
