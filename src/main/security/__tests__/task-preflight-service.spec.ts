import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveInstructionStackMock = vi.fn();
const diagnoseMock = vi.fn();
const getServersMock = vi.fn();
const canReadMock = vi.fn();
const canWriteMock = vi.fn();
const getFilesystemConfigMock = vi.fn();
const getFilesystemStatsMock = vi.fn();
const getNetworkConfigMock = vi.fn();
const getPermissionConfigMock = vi.fn();

vi.mock('../../core/config/instruction-resolver', () => ({
  resolveInstructionStack: resolveInstructionStackMock,
}));

vi.mock('../../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: diagnoseMock,
  }),
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
    getServersMock.mockReset();
    canReadMock.mockReset();
    canWriteMock.mockReset();
    getFilesystemConfigMock.mockReset();
    getFilesystemStatsMock.mockReset();
    getNetworkConfigMock.mockReset();
    getPermissionConfigMock.mockReset();

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
});
