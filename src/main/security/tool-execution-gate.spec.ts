import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from './permission-manager';

const {
  mockEnforce,
  mockCheckToolPermission,
  mockValidateToolInput,
  mockValidateBash,
  mockCanRead,
  mockCanWrite,
  mockRecordNetworkRequest,
} = vi.hoisted(() => ({
  mockEnforce: vi.fn(),
  mockCheckToolPermission: vi.fn(),
  mockValidateToolInput: vi.fn(),
  mockValidateBash: vi.fn(),
  mockCanRead: vi.fn(),
  mockCanWrite: vi.fn(),
  mockRecordNetworkRequest: vi.fn(),
}));

vi.mock('./permission-enforcer', () => ({
  getPermissionEnforcer: vi.fn(() => ({
    enforce: mockEnforce,
  })),
}));

vi.mock('./tool-permission-checker', () => ({
  getToolPermissionChecker: vi.fn(() => ({
    checkPermission: mockCheckToolPermission,
  })),
}));

vi.mock('./tool-validator', () => ({
  getToolValidator: vi.fn(() => ({
    validateInput: mockValidateToolInput,
  })),
}));

vi.mock('./bash-validation', () => ({
  getBashValidationPipeline: vi.fn(() => ({
    validate: mockValidateBash,
  })),
}));

vi.mock('./filesystem-policy', () => ({
  getFilesystemPolicy: vi.fn(() => ({
    canRead: mockCanRead,
    canWrite: mockCanWrite,
  })),
}));

vi.mock('./network-policy', () => ({
  getNetworkPolicy: vi.fn(() => ({
    recordRequest: mockRecordNetworkRequest,
  })),
}));

import { ToolExecutionGate } from './tool-execution-gate';

const request: PermissionRequest = {
  id: 'perm-1',
  instanceId: 'instance-1',
  scope: 'tool_use',
  resource: 'tool:Bash',
  context: {
    workingDirectory: '/tmp/project',
    depth: 1,
    yoloMode: false,
  },
  timestamp: 1,
};

describe('ToolExecutionGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforce.mockReturnValue({
      action: 'allow',
      reason: 'Matched rule: allow bash',
      mode: 'workspace_write',
      source: 'rule',
      request,
      fromCache: false,
      decidedAt: 1,
    });
    mockCheckToolPermission.mockReturnValue({ behavior: 'allow' });
    mockValidateToolInput.mockReturnValue({ valid: true, errors: [] });
    mockCanRead.mockReturnValue(true);
    mockCanWrite.mockReturnValue(true);
    mockRecordNetworkRequest.mockReturnValue({ allowed: true, reason: 'Domain is in allowlist' });
    mockValidateBash.mockReturnValue({
      valid: true,
      risk: 'safe',
      command: 'pwd',
      intent: 'read_only',
      evasionFlags: {},
      submoduleResults: [],
    });
  });

  it('denies invalid tool input before permission approval is used', () => {
    mockValidateToolInput.mockReturnValue({
      valid: false,
      errors: ['Input contains path traversal sequences (..)'],
    });

    const decision = new ToolExecutionGate().evaluate({
      request,
      toolName: 'Read',
      toolInput: { path: '../secret.txt' },
    });

    expect(decision.action).toBe('deny');
    expect(decision.source).toBe('tool-validator');
  });

  it('denies file reads blocked by the filesystem policy', () => {
    mockCanRead.mockReturnValue(false);

    const decision = new ToolExecutionGate().evaluate({
      request: {
        ...request,
        scope: 'file_read',
        resource: '/etc/shadow',
      },
      toolName: 'Read',
      toolInput: { file_path: '/etc/shadow' },
    });

    expect(decision.action).toBe('deny');
    expect(decision.source).toBe('filesystem-policy');
    expect(decision.reason).toContain('/etc/shadow');
    expect(mockCanRead).toHaveBeenCalledWith('/etc/shadow');
  });

  it('denies network requests blocked by the network policy', () => {
    mockRecordNetworkRequest.mockReturnValue({
      allowed: false,
      reason: 'Domain not in allowlist: example.invalid',
    });

    const decision = new ToolExecutionGate().evaluate({
      request: {
        ...request,
        scope: 'network_access',
        resource: 'https://example.invalid/hook',
      },
      toolName: 'Fetch',
      toolInput: { url: 'https://example.invalid/hook' },
    });

    expect(decision.action).toBe('deny');
    expect(decision.source).toBe('network-policy');
    expect(decision.reason).toContain('not in allowlist');
    expect(mockRecordNetworkRequest).toHaveBeenCalledWith('https://example.invalid/hook');
  });

  it('blocks destructive bash commands through the same gate', () => {
    mockValidateBash.mockReturnValue({
      valid: false,
      risk: 'blocked',
      message: 'Destructive command detected',
      command: 'rm -rf /',
      intent: 'destructive',
      evasionFlags: {},
      submoduleResults: [],
    });

    const decision = new ToolExecutionGate().evaluate({
      request: {
        ...request,
        scope: 'bash_execute',
        resource: 'bash:rm -rf /',
      },
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
    });

    expect(decision.action).toBe('deny');
    expect(decision.source).toBe('bash-validation');
    expect(decision.reason).toContain('Destructive command');
  });

  it('requires approval when bash validation warns on an auto-allow path', () => {
    mockValidateBash.mockReturnValue({
      valid: true,
      risk: 'warning',
      message: 'Interactive privilege escalation',
      command: 'sudo -i',
      intent: 'system_admin',
      evasionFlags: {},
      submoduleResults: [],
    });

    const decision = new ToolExecutionGate().evaluate({
      request: {
        ...request,
        scope: 'bash_execute',
        resource: 'bash:sudo -i',
      },
      toolName: 'Bash',
      toolInput: { command: 'sudo -i' },
    });

    expect(decision.action).toBe('ask');
    expect(decision.source).toBe('bash-validation');
  });

  it('auto-allows read-only bash for child instances when no explicit rule matched', () => {
    mockEnforce.mockReturnValue({
      action: 'ask',
      reason: 'No matching rule - using default action',
      mode: 'workspace_write',
      source: 'mode',
      request,
      fromCache: false,
      decidedAt: 1,
    });
    mockValidateBash.mockReturnValue({
      valid: true,
      risk: 'safe',
      command: 'ls -la /tmp/project/src/file.ts 2>&1 || echo "GONE"',
      intent: 'read_only',
      evasionFlags: {},
      submoduleResults: [],
    });

    const decision = new ToolExecutionGate().evaluate({
      request: {
        ...request,
        scope: 'bash_execute',
        resource: 'bash:ls -la /tmp/project/src/file.ts',
        context: {
          ...request.context,
          isChildInstance: true,
          depth: 1,
        },
      },
      toolName: 'Bash',
      toolInput: { command: 'ls -la /tmp/project/src/file.ts 2>&1 || echo "GONE"' },
    });

    expect(decision.action).toBe('allow');
    expect(decision.source).toBe('bash-validation');
    expect(decision.reason).toContain('read-only Bash');
    expect(mockValidateBash).toHaveBeenCalledTimes(2);
    expect(mockValidateBash).toHaveBeenLastCalledWith(
      'ls -la /tmp/project/src/file.ts 2>&1 || echo "GONE"',
      expect.objectContaining({ mode: 'read_only', instanceDepth: 1 }),
    );
  });
});
