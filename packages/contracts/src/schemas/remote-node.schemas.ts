import { z } from 'zod';

export const RemoteNodeSetTokenPayloadSchema = z.object({
  token: z.string().min(16).max(256),
});

export const RemoteNodeIssuePairingPayloadSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  ttlMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1_000).optional(),
}).strict();

export const RemoteNodeRevokePayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeRevokePairingPayloadSchema = z.object({
  token: z.string().min(1).max(256),
});

export const RemoteNodeGetPayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeStartServerPayloadSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).optional(),
    host: z.string().min(1).max(255).optional(),
  })
  .optional();

export const RemoteNodeServiceActionPayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeProviderDiagnosePayloadSchema = z.object({
  nodeId: z.string().uuid(),
  provider: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']),
});

export const RemoteNodeRepairDiagnosePayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeRepairCommandPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  platform: z.literal('win32').optional(),
  operatorConfirmedPlatform: z.boolean().optional(),
}).refine((payload) => payload.operatorConfirmedPlatform !== true || payload.platform === 'win32', {
  message: 'operatorConfirmedPlatform requires platform="win32"',
  path: ['operatorConfirmedPlatform'],
});

export const RemoteNodeBrowserAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  profileDir: z.string().trim().min(1).max(1024).optional(),
  headless: z.boolean().optional(),
  chromePath: z.string().trim().min(1).max(1024).optional(),
  remoteDebuggingPort: z.number().int().min(1).max(65535).optional(),
});

export const RemoteNodeExtensionRelayConfigSchema = z.object({
  enabled: z.boolean(),
});

export const RemoteNodeUpdateBrowserAutomationPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  browserAutomation: RemoteNodeBrowserAutomationConfigSchema,
  extensionRelay: RemoteNodeExtensionRelayConfigSchema.optional(),
});

export const RemoteNodeAndroidAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  sdkPath: z.string().trim().min(1).max(1024).optional(),
  defaultAvd: z.string().trim().min(1).max(256).optional(),
  headlessEmulator: z.boolean().optional(),
  maxEmulators: z.number().int().min(1).max(4).optional(),
  bootTimeoutMs: z.number().int().min(10_000).max(600_000).optional(),
  allowPhysicalDevices: z.boolean().optional(),
  injectMaestroMcp: z.boolean().optional(),
  appiumMcp: z.boolean().optional(),
  mobileMcpVersion: z.string().trim().min(1).max(64).optional(),
});

export const RemoteNodeUpdateAndroidAutomationPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  androidAutomation: RemoteNodeAndroidAutomationConfigSchema,
});

export const RemoteNodeRunBrowserLoginPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  url: z.string().trim().max(2048).optional(),
});

export const PairBothHelloSchema = z.object({
  protocolVersion: z.string().min(1).max(16),
  role: z.enum(['coordinator', 'worker']),
  machineName: z.string().trim().min(1).max(120),
  nonce: z.string().min(8).max(256),
  publicKey: z.string().min(16).max(2048),
  pairingSessionId: z.string().min(1).max(128),
}).strict();

export const PairBothCandidateSchema = z.object({
  id: z.string().min(1).max(512),
  product: z.literal('Harness'),
  protocol: z.literal('aio-worker-pair-v1'),
  protocolVersion: z.string().min(1).max(16),
  pairingSessionId: z.string().min(1).max(128),
  friendlyName: z.string().trim().min(1).max(120),
  namespace: z.string().trim().min(1).max(120),
  port: z.number().int().min(1).max(65535),
  coordinatorPublicKey: z.string().min(16).max(2048),
  expiresAt: z.number().int().positive(),
  host: z.string().trim().min(1).max(255),
  addresses: z.array(z.string().trim().min(1).max(255)).max(16),
}).strict();

export const PairBothCoordinatorStartPayloadSchema = z.object({
  host: z.string().trim().min(1).max(255).optional(),
  ttlMs: z.number().int().min(10_000).max(15 * 60_000).optional(),
}).strict().optional();

export const PairBothSessionPayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
}).strict();

export const PairBothWorkerConnectPayloadSchema = z.object({
  candidate: PairBothCandidateSchema,
}).strict();

export const PairBothManualPairingPayloadSchema = z.object({
  input: z.string().trim().min(1).max(20_000),
}).strict();

export const PairBothWorkerRunModePayloadSchema = z.object({
  mode: z.enum(['run-while-open', 'background-service']),
}).strict();

export type ValidatedSetTokenPayload = z.infer<typeof RemoteNodeSetTokenPayloadSchema>;
export type ValidatedIssuePairingPayload = z.infer<typeof RemoteNodeIssuePairingPayloadSchema>;
export type ValidatedRevokePayload = z.infer<typeof RemoteNodeRevokePayloadSchema>;
export type ValidatedRevokePairingPayload = z.infer<typeof RemoteNodeRevokePairingPayloadSchema>;
export type ValidatedGetPayload = z.infer<typeof RemoteNodeGetPayloadSchema>;
export type ValidatedStartServerPayload = z.infer<typeof RemoteNodeStartServerPayloadSchema>;
export type ValidatedServiceActionPayload = z.infer<typeof RemoteNodeServiceActionPayloadSchema>;
export type ValidatedProviderDiagnosePayload = z.infer<typeof RemoteNodeProviderDiagnosePayloadSchema>;
export type ValidatedRepairDiagnosePayload = z.infer<typeof RemoteNodeRepairDiagnosePayloadSchema>;
export type ValidatedRepairCommandPayload = z.infer<typeof RemoteNodeRepairCommandPayloadSchema>;
