/**
 * Recovers a Claude session whose Harness-injected MCP server failed to start.
 *
 * Claude CLI connects its MCP servers once, at process start, and never retries
 * one that failed. A single transient failure (e.g. the Browser Gateway
 * forwarder dying during a main-process stall) therefore left the session
 * without those tools for the rest of its life, and the model could only tell
 * the user to "reconnect via /mcp", which Harness sessions cannot do.
 *
 * Detection is the `system/init` `mcp_servers` report. Recovery is the ordinary
 * native-resume restart (the same path as the Restart button), run only once
 * the turn has settled to idle so no in-flight work is cut off. One automatic
 * restart per failure streak: a server that is still failing afterwards is
 * reported to the user instead of restarted again, and a later init with every
 * Harness server connected ends the streak.
 */

import { getLogger } from '../../logging/logger';
import { COMPUTER_USE_MCP_SERVER_NAME } from '../../desktop-gateway/desktop-mcp-config';
import type { CliMcpServerStatus } from '../../../shared/types/cli.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { isAdapterOnLoan, onAdapterLoanReleased } from './adapter-loan-registry';
import { getInstanceProviderLimitHandler } from '../instance-provider-limit-handler';
import { getInstanceAuthRepairHandler } from '../instance-auth-repair-handler';

const logger = getLogger('HarnessMcpStartupRecovery');

/**
 * Server keys Harness writes into the Claude `--mcp-config` (see
 * browser-mcp-config, orchestrator-tools-mcp-config, codemem/mcp-config and
 * desktop-mcp-config). User-configured servers are deliberately excluded:
 * Harness cannot repair those by respawning.
 */
export const HARNESS_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  'browser-gateway',
  'orchestrator',
  'codemem',
  COMPUTER_USE_MCP_SERVER_NAME,
]);

const MAX_AUTO_RESTARTS_PER_STREAK = 1;

/**
 * Grace between the turn settling and the restart. The renderer flushes a
 * message the user queued during the turn as soon as the session goes idle; a
 * restart racing that send could swallow it. If the send wins, the session is
 * busy again at the re-check and the restart waits for the next settle.
 */
const RESTART_GRACE_MS = 2_000;

export function findFailedHarnessMcpServers(servers: readonly CliMcpServerStatus[]): string[] {
  return servers
    .filter((server) => HARNESS_MCP_SERVER_NAMES.has(server.name) && server.status === 'failed')
    .map((server) => server.name);
}

export interface HarnessMcpStartupRecoveryDeps {
  getInstance: (
    instanceId: string,
  ) => Pick<Instance, 'status' | 'adapterGeneration' | 'parentId'> | undefined;
  restartInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
  emitNotice: (instanceId: string, message: OutputMessage) => void;
  /**
   * True while a provider-limit park or auth-repair block holds the session.
   * restartInstance disarms those holds, so an automatic restart must wait for
   * them to clear rather than silently cancel them. Defaults to the real
   * handlers; injectable for specs.
   */
  isOnHold?: (instanceId: string) => boolean;
  /**
   * LT-020: a same-session loop borrows this instance's adapter and the status
   * reads idle between borrowed turns while the iteration is still in flight.
   * Loops re-borrow per iteration, so a restart outside a loan is safe.
   * Defaults to the real loan registry; injectable for specs.
   */
  isAdapterOnLoan?: (instanceId: string) => boolean;
  onAdapterLoanReleased?: (listener: (instanceId: string) => void) => unknown;
  /** Defers the restart check past RESTART_GRACE_MS. Injectable for tests. */
  schedule?: (callback: () => void) => void;
}

interface RecoveryEntry {
  /** Adapter generation whose init reported the failure, while a restart is owed. */
  pendingGeneration: number | null;
  failedServers: string[];
  autoRestartsUsed: number;
  restarting: boolean;
  /** Generation already told that no further automatic restart will happen. */
  exhaustedNoticeGeneration: number | null;
}

export class HarnessMcpStartupRecovery {
  private readonly entries = new Map<string, RecoveryEntry>();
  private readonly schedule: (callback: () => void) => void;
  private readonly isAdapterOnLoan: (instanceId: string) => boolean;
  private readonly isOnHold: (instanceId: string) => boolean;
  private subscribedToLoanReleases = false;

  constructor(private readonly deps: HarnessMcpStartupRecoveryDeps) {
    this.isAdapterOnLoan = deps.isAdapterOnLoan ?? isAdapterOnLoan;
    this.isOnHold = deps.isOnHold ?? ((instanceId) => (
      getInstanceProviderLimitHandler().isParked(instanceId)
      || getInstanceAuthRepairHandler().isBlocked(instanceId)
    ));
    this.schedule = deps.schedule ?? ((callback) => {
      setTimeout(callback, RESTART_GRACE_MS);
    });
  }

  recordStartupStatus(
    instanceId: string,
    adapterGeneration: number,
    servers: readonly CliMcpServerStatus[],
  ): void {
    const failed = findFailedHarnessMcpServers(servers);
    if (failed.length === 0) {
      // Healthy start ends any failure streak.
      this.entries.delete(instanceId);
      return;
    }

    const entry = this.entries.get(instanceId) ?? {
      pendingGeneration: null,
      failedServers: [],
      autoRestartsUsed: 0,
      restarting: false,
      exhaustedNoticeGeneration: null,
    };
    this.entries.set(instanceId, entry);
    if (
      entry.pendingGeneration === adapterGeneration
      || entry.exhaustedNoticeGeneration === adapterGeneration
    ) {
      // A repeated init from a process we have already handled.
      return;
    }
    entry.failedServers = failed;

    if (entry.autoRestartsUsed >= MAX_AUTO_RESTARTS_PER_STREAK) {
      entry.exhaustedNoticeGeneration = adapterGeneration;
      logger.warn('Harness MCP server still failing after automatic restart; not restarting again', {
        instanceId,
        failedServers: failed,
        adapterGeneration,
      });
      this.notify(
        instanceId,
        `${describeServers(failed)} failed to start again after an automatic restart, so those tools are `
        + 'still unavailable in this session. Restart the session to try again; if it keeps failing, '
        + 'check the Harness logs.',
        failed,
      );
      return;
    }

    if (this.deps.getInstance(instanceId)?.parentId) {
      // An orchestration child is driven by its parent, which may message it at
      // any moment; restarting it underneath the parent is not ours to decide.
      entry.exhaustedNoticeGeneration = adapterGeneration;
      logger.warn('Harness MCP server failed to start in an orchestration child; not auto-restarting', {
        instanceId,
        failedServers: failed,
        adapterGeneration,
      });
      this.notify(
        instanceId,
        `${describeServers(failed)} failed to start in this session, so those tools are unavailable. `
        + 'Restart the session to reconnect them.',
        failed,
      );
      return;
    }

    entry.pendingGeneration = adapterGeneration;
    if (!this.subscribedToLoanReleases) {
      // Lazy: a failure is rare, and the registry's listener set is global.
      this.subscribedToLoanReleases = true;
      (this.deps.onAdapterLoanReleased ?? onAdapterLoanReleased)((id) => this.noteSettled(id));
    }
    logger.warn('Harness MCP server failed to start; session restart scheduled for when the turn settles', {
      instanceId,
      failedServers: failed,
      adapterGeneration,
    });
    this.notify(
      instanceId,
      `${describeServers(failed)} failed to start in this session, so those tools are unavailable for `
      + 'now. Harness will restart the session to reconnect them once it is idle.',
      failed,
    );
    this.noteSettled(instanceId);
  }

  /** Call whenever the instance may have become idle. Cheap when nothing is owed. */
  noteSettled(instanceId: string): void {
    const pendingGeneration = this.entries.get(instanceId)?.pendingGeneration;
    if (pendingGeneration === undefined || pendingGeneration === null) {
      return;
    }
    this.schedule(() => {
      void this.restartIfOwed(instanceId);
    });
  }

  forget(instanceId: string): void {
    this.entries.delete(instanceId);
  }

  private async restartIfOwed(instanceId: string): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry || entry.pendingGeneration === null || entry.restarting) {
      return;
    }
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      this.entries.delete(instanceId);
      return;
    }
    if (instance.adapterGeneration !== entry.pendingGeneration) {
      // Something else already replaced the CLI process, which reconnected
      // every MCP server; its own init decides whether anything is still owed.
      entry.pendingGeneration = null;
      return;
    }
    if (instance.status !== 'idle' || this.isOnHold(instanceId) || this.isAdapterOnLoan(instanceId)) {
      // Still working, waiting on the user, parked, or lent to a loop; retry at
      // the next settle or loan release.
      return;
    }

    entry.pendingGeneration = null;
    entry.autoRestartsUsed += 1;
    entry.restarting = true;
    logger.info('Restarting session to reconnect failed Harness MCP servers', {
      instanceId,
      failedServers: entry.failedServers,
    });
    try {
      const outcome = await this.deps.restartInstance(instanceId);
      if (!outcome.success) {
        // restartInstance already reports the failure in the conversation.
        logger.warn('Automatic restart for failed Harness MCP servers did not succeed', {
          instanceId,
          error: outcome.error,
        });
      }
    } catch (error) {
      logger.warn('Automatic restart for failed Harness MCP servers threw', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      entry.restarting = false;
    }
  }

  private notify(instanceId: string, content: string, failedServers: string[]): void {
    this.deps.emitNotice(instanceId, {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content,
      metadata: { source: 'harness-mcp-startup-failed', failedServers },
    });
  }
}

const SERVER_LABELS: Record<string, string> = {
  'browser-gateway': 'Browser Gateway',
  orchestrator: 'Harness orchestrator tools',
  codemem: 'Codemem',
  [COMPUTER_USE_MCP_SERVER_NAME]: 'Computer Use',
};

function describeServers(names: readonly string[]): string {
  const labels = names.map((name) => SERVER_LABELS[name] ?? name);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
