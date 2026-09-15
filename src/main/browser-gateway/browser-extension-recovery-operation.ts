import type {
  BrowserExtensionRecoveryChannelSummary,
  BrowserExtensionRecoveryFailureReason,
  BrowserGatewayResult,
  BrowserRecoverExtensionResult,
} from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { BrowserExtensionRecoverResultSchema } from '../remote-node/node-control-rpc-schemas';
import { sendServiceRpc } from '../remote-node/service-rpc-client';
import { getWorkerNodeConnectionServer } from '../remote-node/worker-node-connection';
import {
  COORDINATOR_TO_NODE,
} from '../remote-node/worker-node-rpc';
import {
  getWorkerNodeRegistry,
  type WorkerNodeRegistry,
} from '../remote-node/worker-node-registry';
import {
  BROWSER_EXTENSION_CONTACT_FRESH_MS,
  isBrowserExtensionContactFresh,
  type BrowserExtensionContactStateReader,
} from './browser-extension-contact-state';
import { classifyRemoteExtensionContact } from './browser-extension-node-contact';
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
  resetNodeConnection?: (nodeId: string) => boolean;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

/**
 * Recovers a remote extension channel for one of two confirmed incidents, and
 * deliberately has no browser driver, extension-command, tab, terminal, or CLI
 * dependency:
 * - silent + native_host_stdin_eof: restart the worker's native-host relay;
 * - relay_not_forwarding: the relay and extension are healthy but the worker's
 *   coordinator connection drops every forwarded poll (the 2026-09-15
 *   stale-socket loop), so reset that connection instead.
 */
export class BrowserExtensionRecoveryOperation {
  private readonly workerNodeRegistry: Pick<WorkerNodeRegistry, 'getHealthyNodes'>;
  private readonly extensionContactState: BrowserExtensionContactStateReader;
  private readonly callServiceRpc: NonNullable<BrowserGatewayServiceOptions['sendServiceRpc']>;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly resetNodeConnection: (nodeId: string) => boolean;
  private readonly result: BrowserExtensionRecoveryOperationOptions['result'];

  constructor(options: BrowserExtensionRecoveryOperationOptions) {
    this.workerNodeRegistry = options.workerNodeRegistry ?? getWorkerNodeRegistry();
    this.extensionContactState = options.extensionContactState;
    this.callServiceRpc = options.sendServiceRpc ?? sendServiceRpc;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.pollTimeoutMs = Math.max(0, options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.resetNodeConnection = options.resetNodeConnection
      ?? ((nodeId) => getWorkerNodeConnectionServer().resetNodeConnection(
        nodeId,
        'browser.recover_extension: relay_not_forwarding',
      ));
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
    if (before.channelState === 'relay_not_forwarding') {
      return this.recoverByConnectionReset(request, node, before, startedAt);
    }
    if (!before.silent || before.lastDisconnect?.reason !== 'native_host_stdin_eof') {
      return this.refused(
        request,
        'browser_extension_recovery_incident_not_confirmed',
        'Extension recovery refused because health does not match a silent native-host EOF '
          + 'or relay_not_forwarding incident',
      );
    }
    const baselineContactAt = before.lastContactAt;
    if (baselineContactAt === undefined) {
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
        'extension_relay',
      );
    }

    const after = await this.waitForRecovery(node, before, (summary) =>
      summary.lastContactAt !== undefined
      && summary.lastContactAt > baselineContactAt
      && !summary.silent
      && isBrowserExtensionContactFresh(summary.lastContactAt, this.now(), BROWSER_EXTENSION_CONTACT_FRESH_MS));
    return after.recovered
      ? this.finished(request, node, 'recovered', before, after.summary, startedAt, undefined,
        'Worker extension relay recovered with fresh contact', 'extension_relay')
      : this.finished(request, node, 'timed_out', before, after.summary, startedAt,
        'browser_extension_recovery_timeout', 'Worker extension relay recovery timed out without fresh contact',
        'extension_relay');
  }

  /**
   * relay_not_forwarding: restarting the relay or native host cannot help —
   * both are healthy. Close the worker's coordinator socket (non-revoking) and
   * succeed only on a poll the COORDINATOR observes after the reset; the relay
   * clock is exactly the signal that lied during the incident.
   */
  private async recoverByConnectionReset(
    request: BrowserGatewayRecoverExtensionRequest,
    node: WorkerNodeInfo,
    before: BrowserExtensionRecoveryChannelSummary,
    startedAt: number,
  ): Promise<BrowserGatewayResult<BrowserRecoverExtensionResult>> {
    let reset = false;
    try {
      reset = this.resetNodeConnection(node.id);
    } catch {
      reset = false;
    }
    if (!reset) {
      return this.finished(request, node, 'failed', before, before, startedAt,
        'browser_extension_recovery_failed', 'Worker connection reset failed: the node has no open coordinator socket',
        'connection_reset');
    }
    const resetAt = this.now();
    const after = await this.waitForRecovery(node, before, (summary) =>
      summary.coordinatorPollAt !== undefined
      && summary.coordinatorPollAt > resetAt
      && isBrowserExtensionContactFresh(summary.coordinatorPollAt, this.now(), BROWSER_EXTENSION_CONTACT_FRESH_MS));
    return after.recovered
      ? this.finished(request, node, 'recovered', before, after.summary, startedAt, undefined,
        'Worker connection reset; the coordinator is receiving extension polls again', 'connection_reset')
      : this.finished(request, node, 'timed_out', before, after.summary, startedAt,
        'browser_extension_recovery_timeout',
        'Worker connection reset, but no extension poll reached the coordinator before the deadline',
        'connection_reset');
  }

  private async waitForRecovery(
    node: WorkerNodeInfo,
    before: BrowserExtensionRecoveryChannelSummary,
    isRecovered: (summary: BrowserExtensionRecoveryChannelSummary) => boolean,
  ): Promise<{ recovered: boolean; summary: BrowserExtensionRecoveryChannelSummary }> {
    let after = before;
    const deadline = this.now() + this.pollTimeoutMs;
    const maxPolls = Math.ceil(this.pollTimeoutMs / this.pollIntervalMs) + 1;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const currentNode = this.workerNodeRegistry.getHealthyNodes()
        .find((candidate) => candidate.id === node.id);
      if (currentNode) {
        after = this.channelSummary(currentNode);
      }
      if (after.enabled && after.running && isRecovered(after)) {
        return { recovered: true, summary: after };
      }
      const remainingMs = deadline - this.now();
      if (poll === maxPolls - 1 || remainingMs <= 0) {
        break;
      }
      await this.delay(Math.min(this.pollIntervalMs, remainingMs));
    }
    return { recovered: false, summary: after };
  }

  private channelSummary(node: WorkerNodeInfo): BrowserExtensionRecoveryChannelSummary {
    const relay = node.capabilities.extensionRelay;
    const enabled = relay?.enabled ?? Boolean(node.capabilities.hasExtensionRelay);
    const running = relay?.running ?? Boolean(node.capabilities.hasExtensionRelay);
    const clocks = classifyRemoteExtensionContact({
      coordinatorPollAt: this.extensionContactState.getLastExtensionContactAt(node.id),
      relayContactAt: relay?.lastExtensionContactAt,
      nodeConnectedAt: node.connectedAt,
      now: this.now(),
    });
    const channelState = enabled && running ? clocks.state : 'fresh';
    const disconnect = this.extensionContactState.getLastDisconnect?.(node.id);
    return {
      enabled,
      running,
      silent: channelState === 'silent',
      channelState,
      ...(clocks.lastContactAt !== undefined ? { lastContactAt: clocks.lastContactAt } : {}),
      ...(clocks.coordinatorPollAt !== undefined ? { coordinatorPollAt: clocks.coordinatorPollAt } : {}),
      ...(clocks.relayContactAt !== undefined ? { relayContactAt: clocks.relayContactAt } : {}),
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
    recoveryAction: NonNullable<BrowserRecoverExtensionResult['recoveryAction']>,
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
        recoveryAction,
        elapsedMs: Math.max(0, Math.round(this.now() - startedAt)),
        before,
        after,
      },
    });
  }
}
