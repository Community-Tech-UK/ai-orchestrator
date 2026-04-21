import { EventEmitter } from 'events';
import type {
  McpLifecyclePhase,
  McpLifecyclePhaseReport,
  McpManagerState,
  McpServerConfig,
  McpServerLifecycleReport,
} from '../../shared/types/mcp.types';
import { getLogger } from '../logging/logger';
import { McpManager, getMcpManager } from './mcp-manager';

const logger = getLogger('McpLifecycleManager');

const ALL_PHASES: McpLifecyclePhase[] = ['transport', 'initialize', 'discover', 'ready'];

function createEmptyReport(serverId: string): McpServerLifecycleReport {
  return {
    serverId,
    status: 'disconnected',
    retryCount: 0,
    phases: ALL_PHASES.map((phase) => ({ phase, state: 'pending' })),
  };
}

export class McpLifecycleManager extends EventEmitter {
  private readonly reports = new Map<string, McpServerLifecycleReport>();

  constructor(private readonly manager: McpManager) {
    super();
    this.attach();
  }

  async connect(serverId: string): Promise<void> {
    const report = this.ensureReport(serverId);
    report.status = 'connecting';
    this.resetPhases(report);
    this.emit('report:updated', report);

    try {
      await this.manager.connect(serverId);
    } catch (error) {
      report.retryCount += 1;
      report.status = 'degraded';
      report.error = error instanceof Error ? error.message : String(error);
      this.emit('report:updated', report);
      logger.warn('Retrying MCP server connection after initial failure', {
        serverId,
        error: report.error,
      });

      await this.manager.disconnect(serverId);
      await this.manager.connect(serverId);
    }
  }

  async restart(serverId: string): Promise<void> {
    const report = this.ensureReport(serverId);
    this.resetPhases(report);
    report.status = 'connecting';
    this.emit('report:updated', report);
    await this.manager.restart(serverId);
  }

  getServerReport(serverId: string): McpServerLifecycleReport | undefined {
    return this.reports.get(serverId);
  }

  getServers(): McpServerConfig[] {
    return this.manager.getServers().map((server) => ({
      ...server,
      lifecycle: this.reports.get(server.id) ?? createEmptyReport(server.id),
    }));
  }

  getState(): McpManagerState {
    return {
      ...this.manager.getState(),
      servers: this.getServers(),
    };
  }

  private attach(): void {
    this.manager.on('server:connected', (serverId) => {
      const report = this.ensureReport(serverId);
      report.status = 'connected';
      report.error = undefined;
      this.markPhase(report, 'ready', 'succeeded');
      this.emit('report:updated', report);
    });

    this.manager.on('server:disconnected', (serverId) => {
      const report = this.ensureReport(serverId);
      report.status = 'disconnected';
      this.emit('report:updated', report);
    });

    this.manager.on('server:error', (serverId, error) => {
      const report = this.ensureReport(serverId);
      report.status = report.retryCount > 0 ? 'degraded' : 'error';
      report.error = error;
      this.emit('report:updated', report);
    });

    this.manager.on('server:phase', (serverId, phase, state, error) => {
      const report = this.ensureReport(serverId);
      this.markPhase(report, phase, state, error);
      if (state === 'failed') {
        report.status = report.retryCount > 0 ? 'degraded' : 'error';
        report.error = error;
      } else if (state === 'running') {
        report.status = 'connecting';
      }
      this.emit('report:updated', report);
    });
  }

  private ensureReport(serverId: string): McpServerLifecycleReport {
    const existing = this.reports.get(serverId);
    if (existing) {
      return existing;
    }
    const report = createEmptyReport(serverId);
    this.reports.set(serverId, report);
    return report;
  }

  private resetPhases(report: McpServerLifecycleReport): void {
    report.error = undefined;
    report.phases = ALL_PHASES.map((phase) => ({ phase, state: 'pending' }));
  }

  private markPhase(
    report: McpServerLifecycleReport,
    phase: McpLifecyclePhase,
    state: McpLifecyclePhaseReport['state'],
    error?: string,
  ): void {
    const existing = report.phases.find((candidate) => candidate.phase === phase);
    if (!existing) {
      report.phases.push({ phase, state, error });
      return;
    }

    if (state === 'running') {
      existing.startedAt = Date.now();
      existing.error = undefined;
    } else if (state === 'succeeded' || state === 'failed' || state === 'skipped') {
      existing.finishedAt = Date.now();
    }

    existing.state = state;
    existing.error = error;
  }
}

let lifecycleManager: McpLifecycleManager | null = null;

export function getMcpLifecycleManager(): McpLifecycleManager {
  if (!lifecycleManager) {
    lifecycleManager = new McpLifecycleManager(getMcpManager());
  }
  return lifecycleManager;
}

export function _resetMcpLifecycleManagerForTesting(): void {
  lifecycleManager = null;
}
