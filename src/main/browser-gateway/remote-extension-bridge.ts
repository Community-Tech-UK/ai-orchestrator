import type { z } from 'zod/v4';
import { getBrowserGatewayService } from './browser-gateway-service';
import {
  browserExtensionQueueKeyForNode,
  getBrowserExtensionCommandStore,
  type BrowserExtensionCommandResult,
  type BrowserExtensionPollRequest,
  type BrowserExtensionQueuedCommand,
} from './browser-extension-command-store';
import { getBrowserExtensionTabStore } from './browser-extension-tab-store';
import { getWorkerNodeRegistry, type WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import type { BrowserGatewayAttachExistingTabRequest } from './browser-gateway-service-types';
import type { BrowserGatewayResult } from '@contracts/types/browser';
import type {
  BrowserExtAttachTabParamsSchema,
  BrowserExtCommandReceivedParamsSchema,
  BrowserExtCommandResultParamsSchema,
  BrowserExtDisconnectedParamsSchema,
  BrowserExtPollCommandParamsSchema,
} from '../remote-node/rpc-schemas';
import {
  describeBrowserExtensionContact,
  getBrowserExtensionContactState,
  normalizeBrowserExtensionInstanceId,
  type BrowserExtensionContactSnapshot,
  type BrowserExtensionContactState,
} from './browser-extension-contact-state';
import {
  getBrowserReliabilityEvents,
  type BrowserReliabilityEvents,
} from './browser-reliability-events';
import {
  isSecureBrowserExtensionRuntimeEvidence,
  supportsSecureBrowserExtensionCredentialFill,
} from './browser-extension-credential-compatibility';
import {
  classifyBrowserExtensionIncompatibility,
  nodeHasExtensionRelay,
} from './browser-worker-agent-skew';

type BrowserExtAttachTabParams = z.infer<typeof BrowserExtAttachTabParamsSchema>;
type BrowserExtPollCommandParams = z.infer<typeof BrowserExtPollCommandParamsSchema>;
type BrowserExtCommandResultParams = z.infer<typeof BrowserExtCommandResultParamsSchema>;
type BrowserExtCommandReceivedParams = z.infer<typeof BrowserExtCommandReceivedParamsSchema>;
type BrowserExtDisconnectedParams = z.infer<typeof BrowserExtDisconnectedParamsSchema>;

interface RemoteExtensionBridgeService {
  attachExistingTab(
    request: BrowserGatewayAttachExistingTabRequest,
  ): Promise<BrowserGatewayResult<unknown>>;
}

interface RemoteExtensionCommandStore {
  pollCommand(
    queueKey: string,
    request?: BrowserExtensionPollRequest,
  ): Promise<BrowserExtensionQueuedCommand | null>;
  validateCommandHandoff(queueKey: string, commandId: string): boolean;
  confirmCommandHandoff(queueKey: string, commandId: string): boolean;
  requeueUndeliveredCommand(queueKey: string, commandId: string): boolean;
  resolveCommand(result: BrowserExtensionCommandResult): void;
  markReceived(queueKey: string, commandId: string): void;
  rejectQueue(queueKey: string, reason: string): void;
}

interface RemoteExtensionTabStore {
  suspendNode(nodeId: string, extensionInstanceId?: string | null): number;
  restoreNode(nodeId: string, extensionInstanceId?: string | null): number;
}

type ExtensionRuntimeParams = {
  extensionVersion?: string;
  extensionStartedAt?: number;
  extensionInstanceId?: string;
};

export interface RemoteBrowserExtensionBridgeOptions {
  service?: RemoteExtensionBridgeService;
  commandStore?: RemoteExtensionCommandStore;
  tabStore?: RemoteExtensionTabStore;
  registry?: Pick<WorkerNodeRegistry, 'getNode'>;
  contactState?: BrowserExtensionContactState;
  reliabilityEvents?: Pick<BrowserReliabilityEvents, 'record'>;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
  maxRequestsPerWindow?: number;
  rateLimitWindowMs?: number;
}

interface RateBucket {
  startedAt: number;
  count: number;
}

/**
 * Traffic classes that must never share a rate budget.
 *
 * `bulk` is deferrable telemetry (tab inventory/attachment): a dropped report
 * only degrades the tab list until the next inventory pass.
 *
 * `control` is the correctness-critical command path (`pollCommand`,
 * `commandResult`, `commandReceived`) plus lifecycle signals. Dropping a poll is
 * indistinguishable from "the queue is empty", so the extension re-polls into the
 * same limiter and queued commands time out while the channel still *reports*
 * healthy — the `commands_unanswered` / "the service worker is polling without
 * executing" state.
 *
 * Observed on windows-pc 2026-09-25 20:01: 234 `attachTab` and 2 `pollCommand`
 * rejections in 14s from one tab-inventory burst, which starved command delivery
 * until the extension service worker was reloaded by hand. Partitioning the
 * budget means a flood of the lossy class can no longer silence the lossless one.
 *
 * Both classes keep `maxRequestsPerWindow` because control traffic is naturally
 * bounded well below it (a handful of polls per second) and exists only as a
 * runaway safety net, while `bulk` is the class the original ceiling was written
 * to bound. This is a partition of the budget, not a removal of rate limiting —
 * but be precise: the aggregate ceiling does rise, to `maxRequestsPerWindow` per
 * class (240/s combined at the default). That is acceptable because control
 * traffic never approaches its own budget in normal operation, so realistic
 * combined load is unchanged; what changes is that bulk can no longer spend the
 * control path's allowance.
 */
type RateClass = 'control' | 'bulk';

type ContactTransitionState = 'never' | 'active' | 'lost';

export class RemoteBrowserExtensionBridge {
  private static instance: RemoteBrowserExtensionBridge | null = null;
  private readonly service: RemoteExtensionBridgeService;
  private readonly commandStore: RemoteExtensionCommandStore;
  private readonly tabStore: RemoteExtensionTabStore;
  private readonly registry: Pick<WorkerNodeRegistry, 'getNode'>;
  private readonly contactState: BrowserExtensionContactState;
  private readonly reliabilityEvents: Pick<BrowserReliabilityEvents, 'record'>;
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly now: () => number;
  private readonly maxRequestsPerWindow: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateBuckets = new Map<string, Partial<Record<RateClass, RateBucket>>>();
  private readonly contactTransitions = new Map<string, ContactTransitionState>();
  private readonly lastIncompatibilityReason = new Map<string, string>();

  constructor(options: RemoteBrowserExtensionBridgeOptions = {}) {
    this.service = options.service ?? getBrowserGatewayService();
    this.commandStore = options.commandStore ?? getBrowserExtensionCommandStore();
    this.tabStore = options.tabStore ?? getBrowserExtensionTabStore();
    this.registry = options.registry ?? getWorkerNodeRegistry();
    this.contactState = options.contactState ?? getBrowserExtensionContactState();
    this.reliabilityEvents = options.reliabilityEvents ?? getBrowserReliabilityEvents();
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? 120;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 1_000;
  }

  static getInstance(): RemoteBrowserExtensionBridge {
    if (!this.instance) {
      this.instance = new RemoteBrowserExtensionBridge();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async attachTab(
    nodeId: string,
    params: BrowserExtAttachTabParams,
  ): Promise<BrowserGatewayResult<unknown>> {
    this.consumeRateLimit(nodeId, 'bulk');
    const node = this.registry.getNode(nodeId);
    if (!node) {
      throw new Error(`unknown_remote_browser_node:${nodeId}`);
    }
    if (!this.recordExtensionContact(nodeId, params)) {
      throw new Error(this.denyBrowserCommandsReason(nodeId, params));
    }

    const {
      allowedOrigins: _allowedOrigins,
      extensionOrigin: payloadExtensionOrigin,
      // Only the relay's top-level id routes; see BrowserExtAttachTabParamsSchema.
      extensionInstanceId: _nestedExtensionInstanceId,
      ...payload
    } = params.payload as typeof params.payload & { extensionInstanceId?: unknown };
    const extensionOrigin = params.extensionOrigin ?? payloadExtensionOrigin;
    const extensionInstanceId = normalizeBrowserExtensionInstanceId(params.extensionInstanceId);
    return this.service.attachExistingTab({
      ...payload,
      ...(extensionOrigin ? { extensionOrigin } : {}),
      provider: 'orchestrator',
      nodeId,
      ...(node.name ? { nodeName: node.name } : {}),
      ...(extensionInstanceId ? { extensionInstanceId } : {}),
    });
  }

  pollCommand(
    nodeId: string,
    params: BrowserExtPollCommandParams,
  ): ReturnType<RemoteExtensionCommandStore['pollCommand']> {
    this.consumeRateLimit(nodeId, 'control');
    const allowBrowserCommands = this.recordExtensionContact(nodeId, params);
    const extensionInstanceId = normalizeBrowserExtensionInstanceId(params.extensionInstanceId);
    return this.commandStore.pollCommand(
      browserExtensionQueueKeyForNode(nodeId),
      {
        timeoutMs: params.timeoutMs,
        ...(extensionInstanceId ? { extensionInstanceId } : {}),
        deferHandoffConfirmation: true,
        allowBrowserCommands,
        allowSecureCredentialCommands: allowBrowserCommands,
        ...(!allowBrowserCommands
          ? { denyBrowserCommandsReason: this.denyBrowserCommandsReason(nodeId, params) }
          : {}),
      },
    );
  }

  validateCommandHandoff(nodeId: string, commandId: string): boolean {
    return this.commandStore.validateCommandHandoff(browserExtensionQueueKeyForNode(nodeId), commandId);
  }

  confirmCommandHandoff(nodeId: string, commandId: string): boolean {
    return this.commandStore.confirmCommandHandoff(
      browserExtensionQueueKeyForNode(nodeId),
      commandId,
    );
  }

  requeueUndeliveredCommand(nodeId: string, commandId: string): boolean {
    return this.commandStore.requeueUndeliveredCommand(
      browserExtensionQueueKeyForNode(nodeId),
      commandId,
    );
  }

  commandResult(nodeId: string, params: BrowserExtCommandResultParams): { ok: true } {
    this.consumeRateLimit(nodeId, 'control');
    if (!this.recordExtensionContact(nodeId, params)) {
      this.commandStore.resolveCommand({
        queueKey: browserExtensionQueueKeyForNode(nodeId),
        commandId: params.commandId,
        ok: false,
        error: this.denyBrowserCommandsReason(nodeId, params),
      });
      return { ok: true };
    }
    this.commandStore.resolveCommand({
      queueKey: browserExtensionQueueKeyForNode(nodeId),
      commandId: params.commandId,
      ok: params.ok,
      ...(params.result !== undefined ? { result: params.result } : {}),
      ...(params.error ? { error: params.error } : {}),
    });
    return { ok: true };
  }

  commandReceived(nodeId: string, params: BrowserExtCommandReceivedParams): { ok: true } {
    this.consumeRateLimit(nodeId, 'control');
    if (!this.recordExtensionContact(nodeId, params)) {
      return { ok: true };
    }
    this.commandStore.markReceived(
      browserExtensionQueueKeyForNode(nodeId),
      params.commandId,
    );
    return { ok: true };
  }

  /**
   * The node's native host reported the extension port closing. Recorded for
   * health/error honesty and telemetry only — freshness semantics unchanged,
   * because a service-worker replacement recovers within one alarm cycle and
   * queued commands should keep waiting for it.
   */
  extensionDisconnected(nodeId: string, params: BrowserExtDisconnectedParams): { ok: true } {
    this.consumeRateLimit(nodeId, 'control');
    const reason = params.reason ?? 'unknown';
    const extensionInstanceId = normalizeBrowserExtensionInstanceId(params.extensionInstanceId);
    // Scoped to the closing Chrome profile when the native host names it, so
    // another profile on this node keeps its trust.
    this.contactState.markExtensionDisconnect(nodeId, reason, undefined, extensionInstanceId);
    this.logger.info('Remote browser extension channel disconnected', {
      nodeId,
      reason,
      ...(extensionInstanceId ? { extensionInstanceId } : {}),
    });
    return { ok: true };
  }

  expireNode(nodeId: string): void {
    this.rateBuckets.delete(nodeId);
    this.contactTransitions.delete(nodeId);
    for (const key of this.lastIncompatibilityReason.keys()) {
      if (key === nodeId || key.startsWith(`${nodeId}\u0000`)) {
        this.lastIncompatibilityReason.delete(key);
      }
    }
    this.contactState.forgetNode(nodeId, { preserveRuntimeWatermark: true });
    // forgetNode wiped the disconnect record — re-record it so post-reconnect
    // writes trigger the persistence sentinel's pre-write session check.
    this.contactState.markExtensionDisconnect(nodeId, 'node_ws_disconnected');
    // Suspend (don't delete) attachments: nodeId is stable, so the same ids
    // come back when the node reconnects within the grace window.
    const suspended = this.tabStore.suspendNode(nodeId);
    this.reliabilityEvents.record('node_disconnect', {
      nodeId,
      detail: { suspendedAttachments: suspended },
    });
    this.commandStore.rejectQueue(
      browserExtensionQueueKeyForNode(nodeId),
      `Remote browser extension node disconnected: ${nodeId}`,
    );
  }

  /**
   * Per-node, per-class fixed-window counter. Classes are counted separately so
   * a burst of one class cannot exhaust another class's allowance — see
   * `RateClass` for why the command path must not share with tab chatter.
   */
  private consumeRateLimit(nodeId: string, rateClass: RateClass): void {
    const now = this.now();
    let buckets = this.rateBuckets.get(nodeId);
    if (!buckets) {
      buckets = {};
      this.rateBuckets.set(nodeId, buckets);
    }
    const bucket = buckets[rateClass];
    if (!bucket || now - bucket.startedAt >= this.rateLimitWindowMs) {
      buckets[rateClass] = { startedAt: now, count: 1 };
      return;
    }
    bucket.count += 1;
    if (bucket.count > this.maxRequestsPerWindow) {
      // The class is named so an operator can tell "tab inventory is flooding"
      // (bulk) from "the command path is being throttled" (control) at a glance.
      throw new Error(`browser_extension_relay_rate_limited:${nodeId}:${rateClass}`);
    }
  }

  getLastExtensionContactAt(nodeId: string): number | undefined {
    return this.contactState.getLastExtensionContactAt(nodeId);
  }

  isExtensionContactFresh(nodeId: string): boolean {
    return !this.observeExtensionContact(nodeId).silent;
  }

  describeExtensionContact(nodeId: string): BrowserExtensionContactSnapshot {
    return this.observeExtensionContact(nodeId);
  }

  private recordExtensionContact(
    nodeId: string,
    params: ExtensionRuntimeParams,
  ): boolean {
    const contactedAt = this.now();
    this.observeExtensionContact(nodeId, contactedAt);
    const previousState = this.contactTransitions.get(nodeId) ?? 'never';
    const extensionInstanceId = normalizeBrowserExtensionInstanceId(params.extensionInstanceId);
    const runtime = {
      ...(params.extensionVersion !== undefined ? { extensionVersion: params.extensionVersion } : {}),
      ...(params.extensionStartedAt !== undefined
        ? { extensionStartedAt: params.extensionStartedAt }
        : {}),
      ...(extensionInstanceId ? { extensionInstanceId } : {}),
    };
    this.contactState.markExtensionContact(nodeId, contactedAt);
    this.contactState.markExtensionRuntime(nodeId, runtime);
    // Judged on this Chrome profile's own install. With several profiles on
    // one node, one profile's old or restarting extension must neither block
    // nor suspend the others.
    const allowBrowserCommands = isSecureBrowserExtensionRuntimeEvidence(runtime)
      && supportsSecureBrowserExtensionCredentialFill(this.contactState, nodeId, extensionInstanceId);
    this.recordIncompatibilityTransition(nodeId, runtime, allowBrowserCommands);
    // An id-less (pre-0.2.42) poll speaks only for id-less attachments (`null`),
    // never for another profile's; only expireNode acts on the whole node.
    if (!allowBrowserCommands) {
      this.tabStore.suspendNode(nodeId, extensionInstanceId ?? null);
    } else {
      // 'lost' → the poll resumed; 'never' → first contact after a node
      // (re)registration. Either way the channel is live again: lift any
      // suspension so callers' pre-blip handles keep working.
      const restored = this.tabStore.restoreNode(nodeId, extensionInstanceId ?? null);
      if (previousState === 'lost' || restored > 0) {
        this.reliabilityEvents.record('node_reconnect', {
          nodeId,
          detail: { restoredAttachments: restored },
        });
        this.logger.info('Remote browser extension poll resumed', {
          nodeId,
          lastContactAt: contactedAt,
          restoredAttachments: restored,
        });
      }
    }
    this.contactTransitions.set(nodeId, 'active');
    return allowBrowserCommands;
  }

  private denyBrowserCommandsReason(
    nodeId: string,
    runtime: { extensionVersion?: string; extensionStartedAt?: number },
  ): string {
    const node = this.registry.getNode(nodeId);
    return classifyBrowserExtensionIncompatibility({
      runtime,
      nodeName: node?.name || nodeId,
      hasExtensionRelay: nodeHasExtensionRelay(node),
      ...(node?.capabilities.extensionRelay
        ? { relay: node.capabilities.extensionRelay }
        : {}),
    }).reason;
  }

  private recordIncompatibilityTransition(
    nodeId: string,
    runtime: ExtensionRuntimeParams,
    allowBrowserCommands: boolean,
  ): void {
    // Per install, so two profiles in different states do not log a
    // blocked/unblocked pair on every alternating poll.
    const key = runtime.extensionInstanceId ? `${nodeId}\u0000${runtime.extensionInstanceId}` : nodeId;
    const instance = runtime.extensionInstanceId
      ? { extensionInstanceId: runtime.extensionInstanceId }
      : {};
    if (allowBrowserCommands) {
      if (this.lastIncompatibilityReason.has(key)) {
        this.lastIncompatibilityReason.delete(key);
        this.logger.info('Remote browser extension commands unblocked', { nodeId, ...instance });
      }
      return;
    }
    const reason = this.denyBrowserCommandsReason(nodeId, runtime);
    if (this.lastIncompatibilityReason.get(key) === reason) {
      return;
    }
    this.lastIncompatibilityReason.set(key, reason);
    this.logger.warn('Remote browser extension commands blocked', { nodeId, reason, ...instance });
  }

  private observeExtensionContact(
    nodeId: string,
    now = this.now(),
  ): BrowserExtensionContactSnapshot {
    const snapshot = describeBrowserExtensionContact(
      nodeId,
      this.getLastExtensionContactAt(nodeId),
      now,
    );
    const previousState = this.contactTransitions.get(nodeId) ?? 'never';
    if (snapshot.silent && snapshot.lastContactAt !== undefined && previousState === 'active') {
      this.contactTransitions.set(nodeId, 'lost');
      this.logger.warn('Remote browser extension poll lost', {
        nodeId,
        lastContactAt: snapshot.lastContactAt,
        staleForMs: snapshot.staleForMs ?? 0,
      });
    }
    return snapshot;
  }
}

export function getRemoteBrowserExtensionBridge(): RemoteBrowserExtensionBridge {
  return RemoteBrowserExtensionBridge.getInstance();
}
