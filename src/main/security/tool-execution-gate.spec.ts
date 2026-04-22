import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from './permission-manager';

const {
  mockEnforce,
  mockCheckToolPermission,
  mockValidateToolInput,
  mockValidateBash,
} = vi.hoisted(() => ({
  mockEnforce: vi.fn(),
  mockCheckToolPermission: vi.fn(),
  mockValidateToolInput: vi.fn(),
  mockValidateBash: vi.fn(),
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
});
