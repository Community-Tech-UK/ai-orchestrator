import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsPromisesAccessMock = vi.hoisted(() => vi.fn());
const resolveInstructionStackMock = vi.fn();
const diagnoseMock = vi.fn();
const inspectBranchFreshnessMock = vi.fn();
const getServersMock = vi.fn();
const canReadMock = vi.fn();
const canWriteMock = vi.fn();
const getFilesystemConfigMock = vi.fn();
const getFilesystemStatsMock = vi.fn();
const getNetworkConfigMock = vi.fn();
const getPermissionConfigMock = vi.fn();
const getWorkerNodesMock = vi.fn();

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    access: fsPromisesAccessMock,
  };
});

vi.mock('../../core/config/instruction-resolver', () => ({
  resolveInstructionStack: resolveInstructionStackMock,
}));

vi.mock('../../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: diagnoseMock,
  }),
}));

vi.mock('../../git/branch-freshness', () => ({
  BranchFreshness: class {
    inspect = inspectBranchFreshnessMock;
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../mcp/mcp-manager', () => ({
  getMcpManager: () => ({
    getServers: getServersMock,
  }),
}));

vi.mock('../../remote-node', () => ({
  getWorkerNodeRegistry: () => ({
    getAllNodes: getWorkerNodesMock,
  }),
  isAndroidAutomationReady: (capabilities: {
    hasAndroidMcp?: boolean;
    androidAutomation?: {
      connectedDevices: Array<{ state: string }>;
      emulatorRunning: boolean;
      avds: string[];
      defaultAvd?: string;
    };
  }) => {
    if (!capabilities.hasAndroidMcp) {
      return false;
    }
    const summary = capabilities.androidAutomation;
    if (!summary) {
      return true;
    }
    return (
      summary.connectedDevices.some((device) => device.state === 'device') ||
      summary.emulatorRunning ||
      summary.avds.length > 0 ||
      Boolean(summary.defaultAvd)
    );
  },
}));

vi.mock('../filesystem-policy', () => ({
  getFilesystemPolicy: () => ({
    getConfig: getFilesystemConfigMock,
    getStats: getFilesystemStatsMock,
    canRead: canReadMock,
    canWrite: canWriteMock,
  }),
}));

vi.mock('../network-policy', () => ({
  getNetworkPolicy: () => ({
    getConfig: getNetworkConfigMock,
  }),
}));

vi.mock('../permission-manager', () => ({
  getPermissionManager: () => ({
    getConfig: getPermissionConfigMock,
  }),
}));

describe('TaskPreflightService', () => {
  const tempDirs: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    resolveInstructionStackMock.mockReset();
    diagnoseMock.mockReset();
    inspectBranchFreshnessMock.mockReset();
    getServersMock.mockReset();
    canReadMock.mockReset();
    canWriteMock.mockReset();
    getFilesystemConfigMock.mockReset();
    getFilesystemStatsMock.mockReset();
    getNetworkConfigMock.mockReset();
    getPermissionConfigMock.mockReset();
    getWorkerNodesMock.mockReset();
    fsPromisesAccessMock.mockReset();
    fsPromisesAccessMock.mockImplementation((filePath: fs.PathLike) => fs.promises.access(filePath));

    const { TaskPreflightService } = await import('../task-preflight-service');
    TaskPreflightService._resetForTesting();

    resolveInstructionStackMock.mockResolvedValue({
      projectRoot: '/workspace',
      warnings: [],
      sources: [
        { label: 'AGENTS.md', loaded: true, applied: true },
        { label: '.github/copilot-instructions.md', loaded: true, applied: false },
      ],
    });
    diagnoseMock.mockReturnValue({
      status: 'ready',
      warnings: [],
      browserToolNames: ['playwright'],
    });
    inspectBranchFreshnessMock.mockResolvedValue({
      state: 'fresh',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      summary: 'Branch main is in sync with origin/main.',
    });
    getServersMock.mockReturnValue([
      { name: 'playwright', status: 'connected' },
      { name: 'jira', status: 'configured' },
    ]);
    canReadMock.mockReturnValue(true);
    canWriteMock.mockReturnValue(true);
    getFilesystemConfigMock.mockReturnValue({
      workingDirectory: '/workspace',
      allowTempDir: true,
      tempDirPrefix: 'orchestrator-',
    });
    getFilesystemStatsMock.mockReturnValue({
      readPathCount: 2,
      writePathCount: 1,
      blockedPathCount: 0,
    });
    getNetworkConfigMock.mockReturnValue({
      allowAllTraffic: true,
      allowedDomains: [],
      blockedDomains: [],
      maxRequestsPerMinute: 0,
    });
    getPermissionConfigMock.mockReturnValue({
      defaultAction: 'ask',
    });
    getWorkerNodesMock.mockReturnValue([]);
  });

  afterEach(async () => {
    const { TaskPreflightService } = await import('../task-preflight-service');
    TaskPreflightService._resetForTesting();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports blockers and recommended links for denied read/write/network/browser requirements', async () => {
    canReadMock.mockReturnValue(false);
    canWriteMock.mockReturnValue(false);
    getNetworkConfigMock.mockReturnValue({
      allowAllTraffic: false,
      allowedDomains: [],
      blockedDomains: ['example.com'],
      maxRequestsPerMinute: 60,
    });
    diagnoseMock.mockReturnValue({
      status: 'missing',
      warnings: ['Playwright MCP is not configured.'],
      browserToolNames: [],
    });

    const { getTaskPreflightService } = await import('../task-preflight-service');
    const report = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'repo-job',
      taskType: 'pr-review',
      requiresWrite: true,
      requiresNetwork: true,
      requiresBrowser: true,
    });

    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('denies reads'),
        expect.stringContaining('blocks writes'),
        expect.stringContaining('Network access is effectively blocked'),
        expect.stringContaining('Browser evidence is enabled'),
      ]),
    );
    expect(report.recommendedLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: '/settings' }),
        expect.objectContaining({ route: '/mcp' }),
      ]),
    );
    expect(report.permissions.predictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Filesystem write approval' }),
        expect.objectContaining({ label: 'Network approval' }),
        expect.objectContaining({ label: 'Browser evidence capture' }),
      ]),
    );
    expect(report.branchPolicy).toEqual(expect.objectContaining({
      state: 'fresh',
      action: 'allow',
    }));
  });

  it('surfaces project permission overrides and deny-by-default predictions', async () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'task-preflight-'));
    tempDirs.push(workingDirectory);
    fs.mkdirSync(path.join(workingDirectory, '.orchestrator'), { recursive: true });
    fs.writeFileSync(
      path.join(workingDirectory, '.orchestrator', 'permissions.json'),
      JSON.stringify({ rules: [] }, null, 2),
    );
    getPermissionConfigMock.mockReturnValue({
      defaultAction: 'deny',
    });

    const { getTaskPreflightService } = await import('../task-preflight-service');
    const report = await getTaskPreflightService().getPreflight({
      workingDirectory,
      surface: 'worktree',
      taskType: 'parallel-worktree',
      requiresWrite: true,
    });

    expect(report.warnings).toContain(
      'A project permission file is present. Runtime permission matching may be narrower than the global preset.',
    );
    expect(report.permissions.preset).toBe('deny');
    expect(report.permissions.predictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Write actions denied by default' }),
      ]),
    );
    expect(report.instructionSummary.appliedLabels).toEqual(['AGENTS.md']);
  });

  it('warns when project permission overrides cannot be inspected', async () => {
    const accessError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    fsPromisesAccessMock.mockRejectedValueOnce(accessError);

    const { getTaskPreflightService } = await import('../task-preflight-service');
    const report = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'worktree',
      taskType: 'parallel-worktree',
    });

    expect(report.warnings).toContain(
      'Project permission file could not be checked. Runtime permission matching may include project-scoped rules preflight cannot inspect.',
    );
    expect(report.filesystem.notes).toContain(
      'Project permission overrides could not be inspected.',
    );
  });

  it('surfaces branch-policy warnings and blockers from the typed policy layer', async () => {
    const { getTaskPreflightService } = await import('../task-preflight-service');

    inspectBranchFreshnessMock.mockResolvedValueOnce({
      state: 'stale',
      branch: 'feature/stale',
      upstream: 'origin/main',
      ahead: 0,
      behind: 3,
      summary: 'Branch feature/stale is behind origin/main by 3 commit(s).',
    });

    const staleReport = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'workflow',
      requiresWrite: true,
    });

    expect(staleReport.blockers).toEqual([]);
    expect(staleReport.warnings).toContain('Branch feature/stale is behind origin/main by 3 commit(s).');
    expect(staleReport.branchPolicy).toEqual(expect.objectContaining({
      action: 'warn',
      recommendedRemediation: 'merge-forward',
      failureCategory: 'stale_branch',
    }));

    inspectBranchFreshnessMock.mockResolvedValueOnce({
      state: 'diverged',
      branch: 'feature/diverged',
      upstream: 'origin/main',
      ahead: 2,
      behind: 4,
      summary: 'Branch feature/diverged has diverged from origin/main (2 ahead, 4 behind).',
    });

    const divergedReport = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'repo-job',
      requiresWrite: true,
    });

    expect(divergedReport.blockers).toContain(
      'Branch feature/diverged has diverged from origin/main (2 ahead, 4 behind).',
    );
    expect(divergedReport.branchPolicy).toEqual(expect.objectContaining({
      action: 'block',
      recommendedRemediation: 'rebase',
      failureCategory: 'stale_branch',
    }));
  });

  it('does not diagnose or surface browser warnings for tasks that do not require browser automation', async () => {
    diagnoseMock.mockReturnValue({
      status: 'partial',
      warnings: ['Browser Gateway is partially configured.'],
      browserToolNames: [],
    });

    const { getTaskPreflightService } = await import('../task-preflight-service');
    const report = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'verification',
      taskType: 'android-test',
      requiresAndroid: false,
    });

    expect(diagnoseMock).not.toHaveBeenCalled();
    expect(report.warnings).not.toContain('Browser Gateway is partially configured.');
    expect(report.mcp.browserWarnings).toEqual([]);
  });

  it('blocks Android-required tasks when no connected Android worker is ready', async () => {
    const { getTaskPreflightService } = await import('../task-preflight-service');
    const report = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'verification',
      taskType: 'android-test',
      requiresAndroid: true,
    });

    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no connected Android-capable worker node'),
      ]),
    );
    expect(report.mcp.androidStatus).toBe('missing');
    expect(report.permissions.predictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Android device automation', certainty: 'possible' }),
      ]),
    );
    expect(report.recommendedLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: '/settings' }),
      ]),
    );
  });

  it('passes Android-required tasks when a connected Android-capable worker is ready', async () => {
    getWorkerNodesMock.mockReturnValue([
      {
        name: 'windows-android',
        status: 'connected',
        capabilities: {
          hasAndroidMcp: true,
          androidAutomation: {
            enabled: true,
            sdkPath: 'C:/Android/Sdk',
            adbVersion: 'Android Debug Bridge version 1.0.41',
            avds: ['aio-pixel7-api35'],
            connectedDevices: [],
            emulatorRunning: false,
            hasMaestro: false,
          },
        },
      },
    ]);

    const { getTaskPreflightService } = await import('../task-preflight-service');
    const report = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'verification',
      taskType: 'android-test',
      requiresAndroid: true,
    });

    expect(report.blockers.some((blocker) => blocker.includes('Android testing'))).toBe(false);
    expect(report.mcp.androidStatus).toBe('ready');
    expect(report.mcp.androidNodeNames).toEqual(['windows-android']);
    expect(report.permissions.predictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Android device automation', certainty: 'expected' }),
      ]),
    );
  });

  it('blocks Android-required tasks when the worker has ADB but no usable device or AVD', async () => {
    getWorkerNodesMock.mockReturnValue([
      {
        name: 'windows-adb-only',
        status: 'connected',
        capabilities: {
          hasAndroidMcp: true,
          androidAutomation: {
            enabled: true,
            sdkPath: 'C:/Android/Sdk',
            adbVersion: 'Android Debug Bridge version 1.0.41',
            avds: [],
            connectedDevices: [],
            emulatorRunning: false,
            hasMaestro: false,
          },
        },
      },
    ]);

    const { getTaskPreflightService } = await import('../task-preflight-service');
    const report = await getTaskPreflightService().getPreflight({
      workingDirectory: os.tmpdir(),
      surface: 'verification',
      taskType: 'android-test',
      requiresAndroid: true,
    });

    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no connected Android-capable worker node'),
      ]),
    );
    expect(report.mcp.androidStatus).toBe('missing');
    expect(report.mcp.androidNodeNames).toEqual([]);
  });
});
