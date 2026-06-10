import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const auxGenerateMock = vi.fn();
const getWorkerNodesMock = vi.fn();

vi.mock('../core/config/instruction-resolver', () => ({
  resolveInstructionStack: resolveInstructionStackMock,
}));

vi.mock('../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: diagnoseMock,
  }),
}));

vi.mock('../git/branch-freshness', () => ({
  BranchFreshness: class {
    inspect = inspectBranchFreshnessMock;
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../mcp/mcp-manager', () => ({
  getMcpManager: () => ({
    getServers: getServersMock,
  }),
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeRegistry: () => ({
    getAllNodes: getWorkerNodesMock,
  }),
}));

vi.mock('./filesystem-policy', () => ({
  getFilesystemPolicy: () => ({
    getConfig: getFilesystemConfigMock,
    getStats: getFilesystemStatsMock,
    canRead: canReadMock,
    canWrite: canWriteMock,
  }),
}));

vi.mock('./network-policy', () => ({
  getNetworkPolicy: () => ({
    getConfig: getNetworkConfigMock,
  }),
}));

vi.mock('./permission-manager', () => ({
  getPermissionManager: () => ({
    getConfig: getPermissionConfigMock,
  }),
}));

vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({
    generate: auxGenerateMock,
  }),
}));

describe('TaskPreflightService automation preflight', () => {
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
    auxGenerateMock.mockReset();
    getWorkerNodesMock.mockReset();
    // Default: non-JSON / empty score → advisory scoring is a no-op.
    auxGenerateMock.mockResolvedValue({ text: '{}', decision: { slot: 'approvalScoring' } });

    const { TaskPreflightService } = await import('./task-preflight-service');
    TaskPreflightService._resetForTesting();

    resolveInstructionStackMock.mockResolvedValue({
      projectRoot: '/workspace',
      warnings: [],
      sources: [
        { label: 'AGENTS.md', loaded: true, applied: true },
      ],
    });
    diagnoseMock.mockReturnValue({
      status: 'ready',
      warnings: [],
      browserToolNames: [],
    });
    inspectBranchFreshnessMock.mockResolvedValue({
      state: 'fresh',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      summary: 'Branch main is in sync with origin/main.',
    });
    getServersMock.mockReturnValue([]);
    canReadMock.mockReturnValue(true);
    canWriteMock.mockReturnValue(true);
    getFilesystemConfigMock.mockReturnValue({
      workingDirectory: '/workspace',
      allowTempDir: true,
      tempDirPrefix: 'orchestrator-',
    });
    getFilesystemStatsMock.mockReturnValue({
      readPathCount: 1,
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
    const { TaskPreflightService } = await import('./task-preflight-service');
    TaskPreflightService._resetForTesting();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds unattended permission guidance for automation prompts that write and use the network', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-preflight-'));
    tempDirs.push(repoPath);

    const { getTaskPreflightService } = await import('./task-preflight-service');
    const report = await getTaskPreflightService().getAutomationPreflight({
      workingDirectory: repoPath,
      prompt: 'Run npm install and fix lint errors',
      provider: 'claude',
      model: 'claude-sonnet',
      yoloMode: false,
      expectedUnattended: true,
    });

    expect(report.surface).toBe('automation');
    expect(report.okToSave).toBe(true);
    expect(report.permissions.predictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Filesystem write approval' }),
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unattended automation'),
      ]),
    );
    expect(report.suggestedPermissionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'project',
          permission: 'file_write',
          action: 'allow',
          pattern: path.join(repoPath, '**'),
        }),
        expect.objectContaining({
          scope: 'project',
          permission: 'network_access',
          action: 'ask',
        }),
      ]),
    );
    expect(report.suggestedPromptEdits[0]?.replacementPrompt).toContain('Return a concise summary');
  });

  it('surfaces an advisory risk warning when approvalScoring returns an elevated score', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-preflight-'));
    tempDirs.push(repoPath);
    auxGenerateMock.mockResolvedValue({
      text: JSON.stringify({ score: 0.82, confidence: 0.7, reason: 'Edits files and installs packages unattended' }),
      decision: { slot: 'approvalScoring' },
    });

    const { getTaskPreflightService } = await import('./task-preflight-service');
    const report = await getTaskPreflightService().getAutomationPreflight({
      workingDirectory: repoPath,
      prompt: 'Install dependencies and refactor the auth module',
      provider: 'claude',
      model: 'claude-sonnet',
      yoloMode: false,
      expectedUnattended: false,
    });

    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Advisory risk score 0.82')]),
    );
    // Advisory only — it must never block saving.
    expect(report.okToSave).toBe(true);
  });

  it('ignores advisory scoring failures (graceful fallback, no warning, no block)', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-preflight-'));
    tempDirs.push(repoPath);
    auxGenerateMock.mockRejectedValue(new Error('aux endpoint timed out'));

    const { getTaskPreflightService } = await import('./task-preflight-service');
    const report = await getTaskPreflightService().getAutomationPreflight({
      workingDirectory: repoPath,
      prompt: 'Install dependencies and refactor the auth module',
      provider: 'claude',
      model: 'claude-sonnet',
      yoloMode: false,
      expectedUnattended: false,
    });

    expect(report.warnings.some((w) => w.includes('Advisory risk score'))).toBe(false);
    expect(report.okToSave).toBe(true);
  });
});
