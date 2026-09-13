import type {
  BrowserExtensionRecoveryChannelSummary,
  BrowserExtensionRecoveryFailureReason,
  BrowserGatewayResult,
  BrowserRecoverExtensionResult,
} from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { BrowserExtensionRecoverResultSchema } from '../remote-node/node-control-rpc-schemas';
import { sendServiceRpc } from '../remote-node/service-rpc-client';
import {
  COORDINATOR_TO_NODE,
} from '../remote-node/worker-node-rpc';
import {
  getWorkerNodeRegistry,
  type WorkerNodeRegistry,
} from '../remote-node/worker-node-registry';
import {
  BROWSER_EXTENSION_CONTACT_FRESH_MS,
  describeBrowserExtensionContact,
  isBrowserExtensionContactFresh,
  type BrowserExtensionContactStateReader,
} from './browser-extension-contact-state';
import { resolveBrowserComputerTarget } from './browser-computer-target';
import type {
  BrowserGatewayRecoverExtensionRequest,
  BrowserGatewayServiceOptions,
} from './browser-gateway-service-types';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import { redactAgentString } from './browser-safe-dto';

// The extension reconnect backoff can reach 30s +20% jitter (36s), and a
// recovered worker may need one 10s heartbeat interval before its fresh relay
// contact is visible in the coordinator registry. Keep operational headroom
// above that complete reconnect + publication path.
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

interface BrowserExtensionRecoveryOperationOptions {
  workerNodeRegistry?: Pick<WorkerNodeRegistry, 'getHealthyNodes'>;
  extensionContactState: BrowserExtensionContactStateReader;
  sendServiceRpc?: BrowserGatewayServiceOptions['sendServiceRpc'];
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

/**
 * Recovers only the worker's configured native-host relay. It deliberately has
 * no browser driver, extension-command, tab, terminal, or CLI dependency.
 */
export class BrowserExtensionRecoveryOperation {
  private readonly workerNodeRegistry: Pick<WorkerNodeRegistry, 'getHealthyNodes'>;
  private readonly extensionContactState: BrowserExtensionContactStateReader;
  private readonly callServiceRpc: NonNullable<BrowserGatewayServiceOptions['sendServiceRpc']>;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly result: BrowserExtensionRecoveryOperationOptions['result'];

  constructor(options: BrowserExtensionRecoveryOperationOptions) {
    this.workerNodeRegistry = options.workerNodeRegistry ?? getWorkerNodeRegistry();
    this.extensionContactState = options.extensionContactState;
    this.callServiceRpc = options.sendServiceRpc ?? sendServiceRpc;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.pollTimeoutMs = Math.max(0, options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.result = options.result;
  }

  async run(
    request: BrowserGatewayRecoverExtensionRequest,
  ): Promise<BrowserGatewayResult<BrowserRecoverExtensionResult | null>> {
    const startedAt = this.now();
    const connectedNodes = this.workerNodeRegistry.getHealthyNodes();
    const resolution = resolveBrowserComputerTarget(request, { connectedNodes });
    if (!resolution.ok) {
      return this.refused(
        request,
        'browser_extension_recovery_node_unavailable',
        'Extension recovery refused because the selected remote node is unavailable',
      );
    }
    if (resolution.target.localOnly || !resolution.target.nodeId) {
      return this.refused(
        request,
        'browser_extension_recovery_remote_node_required',
        'Extension recovery requires an explicitly selected connected remote node',
      );
    }

    const node = connectedNodes.find((candidate) => candidate.id === resolution.target.nodeId);
    if (!node) {
      return this.refused(
        request,
        'browser_extension_recovery_node_unavailable',
        'Extension recovery refused because the selected remote node is unavailable',
      );
    }

    const before = this.channelSummary(node);
    if (!before.silent || before.lastDisconnect?.reason !== 'native_host_stdin_eof') {
      return this.refused(
        request,
        'browser_extension_recovery_incident_not_confirmed',
        'Extension recovery refused because health does not match a silent native-host EOF incident',
      );
    }
    if (before.lastContactAt === undefined) {
      return this.refused(
        request,
        'browser_extension_recovery_contact_baseline_missing',
        'Extension recovery refused because there is no prior extension contact timestamp',
      );
    }

    try {
      const response = await this.callServiceRpc(
        node.id,
        COORDINATOR_TO_NODE.BROWSER_EXTENSION_RECOVER,
        {},
      );
      BrowserExtensionRecoverResultSchema.parse(response);
    } catch {
      return this.finished(
        request,
        node,
        'failed',
        before,
        before,
        startedAt,
        'browser_extension_recovery_failed',
        'Worker extension relay recovery failed',
      );
    }

    let after = before;
    const deadline = this.now() + this.pollTimeoutMs;
    const maxPolls = Math.ceil(this.pollTimeoutMs / this.pollIntervalMs) + 1;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const currentNode = this.workerNodeRegistry.getHealthyNodes()
        .find((candidate) => candidate.id === node.id);
      if (currentNode) {
        after = this.channelSummary(currentNode);
      }
      if (
        after.enabled
        && after.running
        && !after.silent
        && after.lastContactAt !== undefined
        && after.lastContactAt > before.lastContactAt
        && isBrowserExtensionContactFresh(
          after.lastContactAt,
          this.now(),
          BROWSER_EXTENSION_CONTACT_FRESH_MS,
        )
      ) {
        return this.finished(
          request,
          node,
          'recovered',
          before,
          after,
          startedAt,
          undefined,
          'Worker extension relay recovered with fresh contact',
        );
      }
      const remainingMs = deadline - this.now();
      if (poll === maxPolls - 1 || remainingMs <= 0) {
        break;
      }
      await this.delay(Math.min(this.pollIntervalMs, remainingMs));
    }

    return this.finished(
      request,
      node,
      'timed_out',
      before,
      after,
      startedAt,
      'browser_extension_recovery_timeout',
      'Worker extension relay recovery timed out without fresh contact',
    );
  }

  private channelSummary(node: WorkerNodeInfo): BrowserExtensionRecoveryChannelSummary {
    const relay = node.capabilities.extensionRelay;
    const stateLastContactAt = this.extensionContactState.getLastExtensionContactAt(node.id);
    const lastContactAt = latestTimestamp(stateLastContactAt, relay?.lastExtensionContactAt);
    const enabled = relay?.enabled ?? Boolean(node.capabilities.hasExtensionRelay);
    const running = relay?.running ?? Boolean(node.capabilities.hasExtensionRelay);
    const silent = enabled && running
      ? describeBrowserExtensionContact(
        node.id,
        lastContactAt,
        this.now(),
        BROWSER_EXTENSION_CONTACT_FRESH_MS,
      ).silent
      : false;
    const disconnect = this.extensionContactState.getLastDisconnect?.(node.id);
    return {
      enabled,
      running,
      silent,
      ...(lastContactAt !== undefined ? { lastContactAt } : {}),
      ...(disconnect
        ? {
          lastDisconnect: {
            at: disconnect.at,
            reason: redactAgentString(disconnect.reason).slice(0, 200),
          },
        }
        : {}),
    };
  }

  private refused(
    request: BrowserGatewayRecoverExtensionRequest,
    reason: BrowserExtensionRecoveryFailureReason,
    summary: string,
  ): BrowserGatewayResult<null> {
    return this.result({
      context: request,
      action: 'recover_extension',
      toolName: 'browser.recover_extension',
      actionClass: 'read',
      decision: 'denied',
      outcome: 'not_run',
      reason,
      summary,
      data: null,
    });
  }

  private finished(
    request: BrowserGatewayRecoverExtensionRequest,
    node: WorkerNodeInfo,
    recoveryStatus: BrowserRecoverExtensionResult['recoveryStatus'],
    before: BrowserExtensionRecoveryChannelSummary,
    after: BrowserExtensionRecoveryChannelSummary,
    startedAt: number,
    reason: BrowserExtensionRecoveryFailureReason | undefined,
    summary: string,
  ): BrowserGatewayResult<BrowserRecoverExtensionResult> {
    const succeeded = recoveryStatus === 'recovered';
    return this.result({
      context: request,
      action: 'recover_extension',
      toolName: 'browser.recover_extension',
      actionClass: 'read',
      decision: 'allowed',
      outcome: succeeded ? 'succeeded' : 'failed',
      ...(reason ? { reason } : {}),
      summary,
      data: {
        nodeId: node.id,
        nodeName: redactAgentString(node.name || node.id).slice(0, 120),
        recoveryStatus,
        elapsedMs: Math.max(0, Math.round(this.now() - startedAt)),
        before,
        after,
      },
    });
  }
}

function latestTimestamp(...values: (number | undefined)[]): number | undefined {
  const timestamps = values.filter((value): value is number => typeof value === 'number');
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}
