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

const WorkerNodeCapabilitiesEventSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.string().max(100),
  cpuCores: z.number().int().nonnegative(),
  totalMemoryMB: z.number().nonnegative(),
  availableMemoryMB: z.number().nonnegative(),
  supportedClis: z.array(z.string().min(1).max(100)).max(100),
  hasBrowserRuntime: z.boolean(),
  hasBrowserMcp: z.boolean(),
  hasAndroidMcp: z.boolean(),
  hasDocker: z.boolean(),
  maxConcurrentInstances: z.number().int().nonnegative(),
  workingDirectories: z.array(z.string().max(4_000)).max(10_000),
  browsableRoots: z.array(z.string().max(4_000)).max(10_000),
  discoveredProjects: z.array(z.unknown()).max(100_000),
}).passthrough();

/** Main-to-renderer payload for REMOTE_NODE_NODES_CHANGED. */
export const RemoteNodeRosterChangedEventSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  status: z.enum(['connecting', 'connected', 'degraded', 'disconnected']),
  address: z.string().max(2_048),
  connected: z.boolean(),
  supportedClis: z.array(z.string().min(1).max(100)).max(100),
  hasBrowserRuntime: z.boolean(),
  hasBrowserMcp: z.boolean(),
  hasAndroidMcp: z.boolean(),
  hasDocker: z.boolean(),
  activeInstances: z.number().int().nonnegative(),
  maxConcurrentInstances: z.number().int().nonnegative(),
  workingDirectories: z.array(z.string().max(4_000)).max(10_000),
  capabilities: WorkerNodeCapabilitiesEventSchema,
}).passthrough()).max(10_000);

const WorkerNodeInfoEventSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  address: z.string().max(2_048).optional(),
  capabilities: WorkerNodeCapabilitiesEventSchema,
  status: z.enum(['connecting', 'connected', 'degraded', 'disconnected']),
  connectedAt: z.number().int().nonnegative().optional(),
  lastHeartbeat: z.number().int().nonnegative().optional(),
  activeInstances: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative().finite().optional(),
}).strict();

export const RemoteNodeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['connected', 'updated']),
    node: WorkerNodeInfoEventSchema,
  }).strict(),
  z.object({
    type: z.literal('disconnected'),
    nodeId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    type: z.literal('flap-storm'),
    nodeId: z.string().min(1).max(200),
    nodeName: z.string().min(1).max(500).optional(),
    replacesInWindow: z.number().int().nonnegative().optional(),
    windowMs: z.number().int().nonnegative().optional(),
  }).strict(),
]);

export const RemoteFsEventSchema = z.object({
  nodeId: z.string().min(1).max(200),
  watchId: z.string().min(1).max(500),
  events: z.array(z.object({
    type: z.enum(['add', 'change', 'delete']),
    path: z.string().min(1).max(10_000),
    isDirectory: z.boolean(),
  }).strict()).max(10_000),
}).strict();

export const RemoteNodeRunBrowserLoginPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  url: z.string().trim().max(2048).optional(),
});

export const TerminalOutputEventSchema = z.object({
  sessionId: z.string().min(1).max(200),
  data: z.string(),
}).strict();

export const TerminalExitEventSchema = z.object({
  sessionId: z.string().min(1).max(200),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
}).strict();

export const TerminalSpawnedEventSchema = z.object({
  sessionId: z.string().min(1).max(200),
  pid: z.number().int().nonnegative(),
  nodeId: z.string().min(1).max(200),
}).strict();

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
