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
  BrowserExtCommandResultParamsSchema,
  BrowserExtPollCommandParamsSchema,
} from '../remote-node/rpc-schemas';
import {
  describeBrowserExtensionContact,
  getBrowserExtensionContactState,
  isBrowserExtensionContactFresh,
  type BrowserExtensionContactSnapshot,
  type BrowserExtensionContactState,
} from './browser-extension-contact-state';

type BrowserExtAttachTabParams = z.infer<typeof BrowserExtAttachTabParamsSchema>;
type BrowserExtPollCommandParams = z.infer<typeof BrowserExtPollCommandParamsSchema>;
type BrowserExtCommandResultParams = z.infer<typeof BrowserExtCommandResultParamsSchema>;

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
  resolveCommand(result: BrowserExtensionCommandResult): void;
  markReceived(queueKey: string, commandId: string): void;
  rejectQueue(queueKey: string, reason: string): void;
}

interface RemoteExtensionTabStore {
  expireNode(nodeId: string): void;
}

export interface RemoteBrowserExtensionBridgeOptions {
  service?: RemoteExtensionBridgeService;
  commandStore?: RemoteExtensionCommandStore;
  tabStore?: RemoteExtensionTabStore;
  registry?: Pick<WorkerNodeRegistry, 'getNode'>;
  contactState?: BrowserExtensionContactState;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
  maxRequestsPerWindow?: number;
  rateLimitWindowMs?: number;
}

interface RateBucket {
  startedAt: number;
  count: number;
}

type ContactTransitionState = 'never' | 'active' | 'lost';

export class RemoteBrowserExtensionBridge {
  private static instance: RemoteBrowserExtensionBridge | null = null;
  private readonly service: RemoteExtensionBridgeService;
  private readonly commandStore: RemoteExtensionCommandStore;
  private readonly tabStore: RemoteExtensionTabStore;
  private readonly registry: Pick<WorkerNodeRegistry, 'getNode'>;
  private readonly contactState: BrowserExtensionContactState;
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly now: () => number;
  private readonly maxRequestsPerWindow: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly contactTransitions = new Map<string, ContactTransitionState>();

  constructor(options: RemoteBrowserExtensionBridgeOptions = {}) {
    this.service = options.service ?? getBrowserGatewayService();
    this.commandStore = options.commandStore ?? getBrowserExtensionCommandStore();
    this.tabStore = options.tabStore ?? getBrowserExtensionTabStore();
    this.registry = options.registry ?? getWorkerNodeRegistry();
    this.contactState = options.contactState ?? getBrowserExtensionContactState();
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
    this.consumeRateLimit(nodeId);
    const node = this.registry.getNode(nodeId);
    if (!node) {
      throw new Error(`unknown_remote_browser_node:${nodeId}`);
    }
    this.recordExtensionContact(nodeId);

    const {
      allowedOrigins: _allowedOrigins,
      extensionOrigin: payloadExtensionOrigin,
      ...payload
    } = params.payload;
    const extensionOrigin = params.extensionOrigin ?? payloadExtensionOrigin;
    return this.service.attachExistingTab({
      ...payload,
      ...(extensionOrigin ? { extensionOrigin } : {}),
      provider: 'orchestrator',
      nodeId,
      ...(node.name ? { nodeName: node.name } : {}),
    });
  }

  pollCommand(
    nodeId: string,
    params: BrowserExtPollCommandParams,
  ): ReturnType<RemoteExtensionCommandStore['pollCommand']> {
    this.consumeRateLimit(nodeId);
    this.recordExtensionContact(nodeId);
    return this.commandStore.pollCommand(
      browserExtensionQueueKeyForNode(nodeId),
      { timeoutMs: params.timeoutMs },
    );
  }

  commandResult(nodeId: string, params: BrowserExtCommandResultParams): { ok: true } {
    this.consumeRateLimit(nodeId);
    this.recordExtensionContact(nodeId);
    this.commandStore.resolveCommand({
      queueKey: browserExtensionQueueKeyForNode(nodeId),
      commandId: params.commandId,
      ok: params.ok,
      ...(params.result !== undefined ? { result: params.result } : {}),
      ...(params.error ? { error: params.error } : {}),
    });
    return { ok: true };
  }

  commandReceived(nodeId: string, params: { commandId: string }): { ok: true } {
    this.consumeRateLimit(nodeId);
    this.recordExtensionContact(nodeId);
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
  extensionDisconnected(nodeId: string, params: { reason?: string }): { ok: true } {
    this.consumeRateLimit(nodeId);
    const reason = params.reason ?? 'unknown';
    this.contactState.markExtensionDisconnect(nodeId, reason);
    this.logger.info('Remote browser extension channel disconnected', { nodeId, reason });
    return { ok: true };
  }

  expireNode(nodeId: string): void {
    this.rateBuckets.delete(nodeId);
    this.contactTransitions.delete(nodeId);
    this.contactState.forgetNode(nodeId);
    this.tabStore.expireNode(nodeId);
    this.commandStore.rejectQueue(
      browserExtensionQueueKeyForNode(nodeId),
      `Remote browser extension node disconnected: ${nodeId}`,
    );
  }

  private consumeRateLimit(nodeId: string): void {
    const now = this.now();
    const bucket = this.rateBuckets.get(nodeId);
    if (!bucket || now - bucket.startedAt >= this.rateLimitWindowMs) {
      this.rateBuckets.set(nodeId, { startedAt: now, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > this.maxRequestsPerWindow) {
      throw new Error(`browser_extension_relay_rate_limited:${nodeId}`);
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

  private recordExtensionContact(nodeId: string): void {
    const contactedAt = this.now();
    this.observeExtensionContact(nodeId, contactedAt);
    const previousState = this.contactTransitions.get(nodeId) ?? 'never';
    this.contactState.markExtensionContact(nodeId, contactedAt);
    if (previousState === 'lost') {
      this.logger.info('Remote browser extension poll resumed', {
        nodeId,
        lastContactAt: contactedAt,
      });
    }
    this.contactTransitions.set(nodeId, 'active');
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
