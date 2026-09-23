/**
 * Trusted-sender gate for the security handler group (remediation plan
 * Task 14 step 2). Business logic is mocked; these tests pin that every
 * channel refuses a non-main-window sender before touching any security
 * subsystem, and that trusted calls still reach the handlers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const securityMocks = vi.hoisted(() => ({
  detectSecretsInContent: vi.fn(() => [{ type: 'api-key' }]),
  detectSecretsInEnvContent: vi.fn(() => []),
  isSecretFile: vi.fn(() => false),
  getFileSensitivity: vi.fn(() => 'low'),
  redactEnvContent: vi.fn(() => ''),
  redactAllSecrets: vi.fn(() => ''),
  auditLog: { clear: vi.fn(), getRecords: vi.fn(() => []), getRecordsByInstance: vi.fn(() => []) },
  getSafeEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  shouldAllowEnvVar: vi.fn(() => ({ allowed: true })),
  bashValidate: vi.fn(() => ({ action: 'allow' })),
  permissionManager: {
    configure: vi.fn(),
    getConfig: vi.fn(() => ({})),
    getStats: vi.fn(() => ({})),
    getLearningStats: vi.fn(() => ({})),
    getPendingBatches: vi.fn(() => []),
    recordBatchDecisionForPending: vi.fn(() => 0),
    recordDecisionByRequestId: vi.fn(() => false),
    getLearnedPatterns: vi.fn(() => []),
    approveLearnedPattern: vi.fn(() => true),
    rejectLearnedPattern: vi.fn(() => true),
    analyzeShadowedRules: vi.fn(() => []),
  },
  getRawDb: vi.fn(() => ({})),
}));

vi.mock('../../../security/secret-detector', () => ({
  detectSecretsInContent: securityMocks.detectSecretsInContent,
  detectSecretsInEnvContent: securityMocks.detectSecretsInEnvContent,
  isSecretFile: securityMocks.isSecretFile,
  getFileSensitivity: securityMocks.getFileSensitivity,
}));
vi.mock('../../../security/secret-redaction', () => ({
  redactEnvContent: securityMocks.redactEnvContent,
  redactAllSecrets: securityMocks.redactAllSecrets,
  getSecretAuditLog: () => securityMocks.auditLog,
}));
vi.mock('../../../security/env-filter', () => ({
  getSafeEnv: securityMocks.getSafeEnv,
  shouldAllowEnvVar: securityMocks.shouldAllowEnvVar,
  DEFAULT_ENV_FILTER_CONFIG: { blockPatterns: [], allowPatterns: [] },
}));
vi.mock('../../../security/bash-validation', () => ({
  getBashValidationPipeline: () => ({ validate: securityMocks.bashValidate }),
}));
vi.mock('../../../security/permission-decision-store', () => ({
  PermissionDecisionStore: vi.fn(() => ({ getByInstance: vi.fn(() => []), getRecent: vi.fn(() => []) })),
}));
vi.mock('../../../security/permission-manager', () => ({
  getPermissionManager: () => securityMocks.permissionManager,
}));
vi.mock('../../../security/tool-permission-checker', () => ({
  getToolPermissionChecker: () => ({ getDenials: vi.fn(() => []), getDenialsForInstance: vi.fn(() => []) }),
}));
vi.mock('../../../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({ getRawDb: securityMocks.getRawDb }),
}));
vi.mock('../../../orchestration/durable-approval-store', () => ({
  DurableApprovalStore: { getInstance: vi.fn(() => ({ listPending: vi.fn(() => []) })) },
}));
vi.mock('../../../orchestration/pending-approval-digest', () => ({
  pendingApprovalDigest: vi.fn(() => null),
}));

import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import { registerSecurityHandlers } from '../security-handlers';

const ensureTrustedSender = vi.fn<(event: unknown, channel: string) => IpcResponse | null>(() => null);

const trustFailure: IpcResponse = {
  success: false,
  error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 1 },
};

function allSecurityMockFns(): ReturnType<typeof vi.fn>[] {
  return [
    securityMocks.detectSecretsInContent,
    securityMocks.detectSecretsInEnvContent,
    securityMocks.isSecretFile,
    securityMocks.getFileSensitivity,
    securityMocks.redactEnvContent,
    securityMocks.redactAllSecrets,
    ...Object.values(securityMocks.auditLog),
    securityMocks.getSafeEnv,
    securityMocks.shouldAllowEnvVar,
    securityMocks.bashValidate,
    ...Object.values(securityMocks.permissionManager),
    securityMocks.getRawDb,
  ] as ReturnType<typeof vi.fn>[];
}

describe('security-handlers trusted sender gate', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    ensureTrustedSender.mockImplementation(() => null);
    registerSecurityHandlers({ ensureTrustedSender });
  });

  it('lets a trusted sender reach the handler and passes the event and channel to the check', async () => {
    const event = { sender: { id: 1 } };

    const detected = await handlers.get(IPC_CHANNELS.SECURITY_DETECT_SECRETS)!(event, {
      content: 'token=abc',
      contentType: 'text',
    });
    const safeEnv = await handlers.get(IPC_CHANNELS.SECURITY_GET_SAFE_ENV)!(event);

    expect(detected).toEqual({ success: true, data: [{ type: 'api-key' }] });
    expect(safeEnv).toEqual({ success: true, data: { PATH: '/usr/bin' } });
    expect(ensureTrustedSender).toHaveBeenCalledWith(event, IPC_CHANNELS.SECURITY_DETECT_SECRETS);
    expect(ensureTrustedSender).toHaveBeenCalledWith(event, IPC_CHANNELS.SECURITY_GET_SAFE_ENV);
  });

  it('still validates payloads for trusted senders', async () => {
    const result = await handlers.get(IPC_CHANNELS.SECURITY_SET_PERMISSION_PRESET)!({}, { preset: 42 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(securityMocks.permissionManager.configure).not.toHaveBeenCalled();
  });

  it('rejects every registered channel for an untrusted sender before any side effect', async () => {
    ensureTrustedSender.mockImplementation(() => trustFailure);

    expect(handlers.size).toBeGreaterThanOrEqual(21);
    for (const handler of handlers.values()) {
      // Deliberately malformed payload: the trust failure must win over validation.
      await expect(handler({}, { unexpected: true })).resolves.toBe(trustFailure);
    }
    for (const fn of allSecurityMockFns()) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
