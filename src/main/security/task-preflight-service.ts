import * as fs from 'fs';
import * as path from 'path';
import { resolveInstructionStack } from '../core/config/instruction-resolver';
import { getBrowserAutomationHealthService } from '../browser-automation/browser-automation-health';
import { getLogger } from '../logging/logger';
import { getMcpManager } from '../mcp/mcp-manager';
import { getFilesystemPolicy } from './filesystem-policy';
import { getNetworkPolicy } from './network-policy';
import { getPermissionManager, type PermissionAction } from './permission-manager';
import type {
  TaskPreflightLink,
  TaskPreflightPrediction,
  TaskPreflightReport,
  TaskPreflightRequest,
} from '../../shared/types/task-preflight.types';

const logger = getLogger('TaskPreflightService');

function actionToPreset(action: PermissionAction): 'allow' | 'ask' | 'deny' {
  return action;
}

export class TaskPreflightService {
  private static instance: TaskPreflightService | null = null;

  static getInstance(): TaskPreflightService {
    if (!this.instance) {
      this.instance = new TaskPreflightService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    // Singleton
  }

  async getPreflight(request: TaskPreflightRequest): Promise<TaskPreflightReport> {
    const workingDirectory = path.resolve(request.workingDirectory);
    const requiresWrite = Boolean(request.requiresWrite);
    const requiresNetwork = Boolean(request.requiresNetwork || request.requiresBrowser);
    const requiresBrowser = Boolean(request.requiresBrowser);

    const [instructionSummary, browserHealth] = await Promise.all([
      resolveInstructionStack({ workingDirectory }),
      Promise.resolve(getBrowserAutomationHealthService().diagnose()),
    ]);

    const filesystem = getFilesystemPolicy();
    const filesystemConfig = filesystem.getConfig();
    const filesystemStats = filesystem.getStats();

    const network = getNetworkPolicy();
    const networkConfig = network.getConfig();

    const permissions = getPermissionManager();
    const permissionConfig = permissions.getConfig();
    const projectPermissionsPath = path.join(workingDirectory, '.orchestrator', 'permissions.json');
    const hasProjectPermissionFile = fs.existsSync(projectPermissionsPath);

    const mcp = getMcpManager();
    const servers = mcp.getServers();
    const connectedServers = servers.filter((server) => server.status === 'connected');

    const blockers: string[] = [];
    const warnings = new Set<string>([
      ...instructionSummary.warnings,
      ...browserHealth.warnings,
    ]);
    const predictions: TaskPreflightPrediction[] = [];
    const links: TaskPreflightLink[] = [];

    const canReadWorkingDirectory = filesystem.canRead(workingDirectory);
    const canWriteWorkingDirectory = filesystem.canWrite(path.join(workingDirectory, '.orchestrator-preflight-write-test'));

    if (!canReadWorkingDirectory) {
      blockers.push('The current filesystem policy denies reads in the selected working directory.');
      links.push({ label: 'Review permissions', route: '/settings' });
    }

    if (requiresWrite && !canWriteWorkingDirectory) {
      blockers.push('This launch is expected to write files, but the current filesystem policy blocks writes in the selected working directory.');
      links.push({ label: 'Review permissions', route: '/settings' });
    }

    if (requiresNetwork && !networkConfig.allowAllTraffic && networkConfig.allowedDomains.length === 0) {
      blockers.push('Network access is effectively blocked because the allowlist is empty and unrestricted traffic is disabled.');
      links.push({ label: 'Open permissions', route: '/settings' });
    }

    if (requiresBrowser && browserHealth.status === 'missing') {
      blockers.push('Browser evidence is enabled, but browser automation is not ready on this machine.');
      links.push({ label: 'Open MCP', route: '/mcp' });
    } else if (requiresBrowser && browserHealth.status === 'partial') {
      warnings.add('Browser evidence is enabled, but browser automation is only partially ready.');
      links.push({ label: 'Open MCP', route: '/mcp' });
    }

    if (permissionConfig.defaultAction === 'ask') {
      if (requiresWrite) {
        predictions.push({
          label: 'Filesystem write approval',
          certainty: 'likely',
          reason: 'The default permission preset is ask, so write actions that miss explicit rules will prompt.',
        });
      }
      if (requiresNetwork) {
        predictions.push({
          label: 'Network approval',
          certainty: 'possible',
          reason: 'The default permission preset is ask and network access is scoped by policy.',
        });
      }
    }

    if (permissionConfig.defaultAction === 'deny') {
      if (requiresWrite) {
        predictions.push({
          label: 'Write actions denied by default',
          certainty: 'expected',
          reason: 'The current permission preset is deny.',
        });
      }
      if (requiresNetwork) {
        predictions.push({
          label: 'Network actions denied by default',
          certainty: 'expected',
          reason: 'The current permission preset is deny.',
        });
      }
    }

    if (requiresBrowser) {
      predictions.push({
        label: 'Browser evidence capture',
        certainty: browserHealth.status === 'ready' ? 'expected' : 'possible',
        reason:
          browserHealth.status === 'ready'
            ? 'Browser automation tooling is ready and the task explicitly requested browser evidence.'
            : 'The task requested browser evidence, but setup warnings may prevent a full capture.',
      });
    }

    if (hasProjectPermissionFile) {
      warnings.add('A project permission file is present. Runtime permission matching may be narrower than the global preset.');
    }

    const report: TaskPreflightReport = {
      generatedAt: Date.now(),
      workingDirectory,
      surface: request.surface,
      taskType: request.taskType,
      instructionSummary: {
        projectRoot: instructionSummary.projectRoot,
        appliedLabels: instructionSummary.sources
          .filter((source) => source.loaded && source.applied)
          .map((source) => source.label),
        warnings: instructionSummary.warnings,
        sources: instructionSummary.sources,
      },
      filesystem: {
        workingDirectory: filesystemConfig.workingDirectory,
        canReadWorkingDirectory,
        canWriteWorkingDirectory,
        readPathCount: filesystemStats.readPathCount,
        writePathCount: filesystemStats.writePathCount,
        blockedPathCount: filesystemStats.blockedPathCount,
        allowTempDir: filesystemConfig.allowTempDir,
        notes: [
          filesystemConfig.allowTempDir
            ? `Temp directory access is enabled with prefix "${filesystemConfig.tempDirPrefix}".`
            : 'Temp directory access is disabled.',
          hasProjectPermissionFile
            ? 'Project-scoped permission overrides were detected.'
            : 'No project-scoped permission override file was detected.',
        ],
      },
      network: {
        allowAllTraffic: networkConfig.allowAllTraffic,
        allowedDomainCount: networkConfig.allowedDomains.length,
        blockedDomainCount: networkConfig.blockedDomains.length,
        sampleAllowedDomains: networkConfig.allowedDomains.slice(0, 8),
        notes: [
          networkConfig.allowAllTraffic
            ? 'All outbound traffic is currently allowed unless explicitly blocked.'
            : 'Outbound traffic is filtered by an allowlist.',
          networkConfig.maxRequestsPerMinute > 0
            ? `Rate limiting is enabled at ${networkConfig.maxRequestsPerMinute} requests per minute.`
            : 'Network rate limiting is disabled.',
        ],
      },
      mcp: {
        configuredCount: servers.length,
        connectedCount: connectedServers.length,
        browserStatus: browserHealth.status,
        browserWarnings: browserHealth.warnings,
        browserToolNames: browserHealth.browserToolNames,
        connectedServerNames: connectedServers.map((server) => server.name),
      },
      permissions: {
        preset: actionToPreset(permissionConfig.defaultAction),
        defaultAction: actionToPreset(permissionConfig.defaultAction),
        predictions,
      },
      blockers,
      warnings: Array.from(warnings),
      recommendedLinks: dedupeLinks(links),
    };

    logger.debug('Generated task preflight report', {
      workingDirectory,
      surface: request.surface,
      blockers: report.blockers.length,
      warnings: report.warnings.length,
    });

    return report;
  }
}

function dedupeLinks(links: TaskPreflightLink[]): TaskPreflightLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.route}:${link.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function getTaskPreflightService(): TaskPreflightService {
  return TaskPreflightService.getInstance();
}
