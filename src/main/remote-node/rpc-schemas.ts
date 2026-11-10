import { z } from 'zod/v4';
import { InstanceSpawnParamsSchema, InstanceChangeModelParamsSchema } from './instance-spawn-rpc-schema';
import { NodeKeepAwakeParamsSchema } from './keep-awake-rpc';
import { InstanceSampleStallProcessParamsSchema } from './stall-process-rpc';
export { InstanceSpawnParamsSchema, InstanceChangeModelParamsSchema } from './instance-spawn-rpc-schema';
export { NodeKeepAwakeParamsSchema } from './keep-awake-rpc';
import { InstanceSendRawParamsSchema } from './instance-interaction-schemas';
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema,
  FsEventParamsSchema,
  FsReadFileParamsSchema,
  FsWriteFileParamsSchema,
} from '../../shared/validation/remote-fs-schemas';
import { FileAttachmentSchema } from '@contracts/schemas/common';
import { BrowserAttachExistingTabRequestSchema } from '@contracts/schemas/browser';
import { withoutNestedExtensionInstanceId } from '../browser-gateway/browser-extension-rpc-payloads';
import { WorkerAgentBuildSummarySchema } from './worker-agent-build-schema';
import { WorkerAccountProfileIdsSchema, WorkerSignInsSchema } from './worker-account-capability-schemas';
import {
  LocalAiDiagnosticReportSchema,
  LocalAiProbeResultSchema,
  LocalAiRepairActionSchema,
  LocalAiRepairResultSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import { AUXILIARY_WORKER_ENDPOINT_MAX_DESCRIPTORS } from '../../shared/types/auxiliary-llm.types';
import { LOCAL_AI_TARGET_NUMERIC_LIMITS } from '../../shared/types/local-ai-guard.types';
import {
  BrowserExtensionRecoverParamsSchema,
  NodeExecParamsSchema,
  WorkerNodeExtensionRelaySummarySchema,
} from './node-control-rpc-schemas';
export * from './node-control-rpc-schemas';
export { FsReadFileParamsSchema, FsWriteFileParamsSchema };
export const BROWSER_CDP_MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const WORKER_NODE_WS_MAX_PAYLOAD_BYTES = BROWSER_CDP_MAX_FRAME_BYTES + 16 * 1024 * 1024;
export const WORKER_NODE_WS_BACKPRESSURE_BYTES = 32 * 1024 * 1024;
const ProviderModelIdSchema = z.string().max(512);
const LocalModelEndpointProviderSchema = z.enum(['ollama', 'openai-compatible']);
const LocalAiEndpointIdSchema = z.string().trim().min(1).max(128);
const LocalAiModelIdSchema = z.string().trim().min(1).max(256);
const LocalAiRoutingRoleSchema = z.enum([
  'compression',
  'memoryDistillation',
  'webExtract',
  'titleGeneration',
  'routingClassification',
  'approvalScoring',
  'approvalAdjudication',
  'loopScoring',
  'retrievalHypothesis',
  'branchScoring',
  'subQueryExecution',
  'verifyOutputSummary',
]);
export const LOCAL_AI_HEALTH_MAX_TIMEOUT_MS = 120_000;
export const LOCAL_AI_HEALTH_MAX_LATENCY_THRESHOLD_MS = 300_000;
// -- Shared sub-schemas -------------------------------------------------------
const WorkerLoadedLocalModelSchema = z.object({
  id: z.string().min(1).max(256),
  contextLength: z.number().int()
    .min(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.min)
    .max(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.max),
});

const HostHealthProcessesSchema = z.array(z.object({
  name: z.string().max(256), pid: z.number().int().nonnegative(), count: z.number().int().nonnegative(),
})).max(10);

// Diagnostic only: a malformed sample is dropped rather than failing the heartbeat.
const WorkerHostHealthSampleSchema = z.object({
  sampledAt: z.number().int().nonnegative(),
  udpEndpoints: z.number().int().nonnegative(),
  tcpConnections: z.number().int().nonnegative(),
  topUdpOwners: HostHealthProcessesSchema,
  topHandleHolders: HostHealthProcessesSchema,
}).optional().catch(undefined);

const WorkerLocalModelCapabilitySchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible']),
  endpointId: z.string().min(1).max(128).optional(),
  baseUrl: z.string().min(1).max(2048),
  models: z.array(z.string().min(1).max(256)).max(512),
  loadedModels: z.array(WorkerLoadedLocalModelSchema).max(64).optional(),
  healthy: z.boolean(),
});

// Diagnostic only: a malformed block is dropped rather than failing the heartbeat. Lists are capped.
const IosAutomationSchema = z.object({
  xcodePath: z.string().max(4096),
  xcodeVersion: z.string().max(64).optional(),
  xcodeBuild: z.string().max(64).optional(),
  licenceAccepted: z.boolean(),
  runtimes: z.array(z.object({
    name: z.string().max(128),
    version: z.string().max(64),
    isAvailable: z.boolean(),
  })).max(64),
  devices: z.array(z.object({
    name: z.string().max(256),
    udid: z.string().max(128),
    platform: z.string().max(64).optional(),
    marketingName: z.string().max(256).optional(),
    osVersion: z.string().max(64).optional(),
    pairingState: z.string().max(64).optional(),
    tunnelState: z.string().max(64).optional(),
    developerMode: z.enum(['enabled', 'disabled', 'unknown']).optional(),
  })).max(64),
  signing: z.object({
    appleAccountPresent: z.boolean().optional(),
    lastError: z.object({
      kind: z.enum(['licence_agreement', 'no_profiles', 'no_team', 'no_certificate', 'no_account']),
      message: z.string().max(1000),
      seenAt: z.number().int().nonnegative(),
      logPath: z.string().max(4096),
    }).optional(),
  }),
  problems: z.array(z.string().max(500)).max(32),
  checkedAt: z.number().int().nonnegative(),
  ready: z.boolean(),
}).optional().catch(undefined);

const HostReadinessSchema = z.object({
  checks: z.array(z.object({
    id: z.enum(['sleep_on_power', 'remote_login_access', 'local_network', 'tailscale_running', 'filevault']),
    status: z.enum(['ok', 'problem', 'note', 'unknown']),
    summary: z.string().max(1000),
    fix: z.string().max(1000).optional(),
    needsAdmin: z.boolean(),
  })).max(16),
  checkedAt: z.number().int().nonnegative(),
}).optional().catch(undefined);

const WorkerNodeCapabilitiesSchema = z.object({
  workerAgent: WorkerAgentBuildSummarySchema.optional(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.string(),
  cpuCores: z.number().int().positive(),
  totalMemoryMB: z.number().int().positive(),
  availableMemoryMB: z.number().int().nonnegative(),
  busyCores: z.number().nonnegative().optional(),
  gpuName: z.string().optional(),
  gpuMemoryMB: z.number().int().optional(),
  supportedClis: z.array(z.string()),
  cliVersions: z.partialRecord(z.enum(['claude', 'gemini', 'auto', 'codex', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode']), z.string().regex(/^\d+\.\d+\.\d+$/).max(64)).optional().catch(undefined),
  instanceModelChange: z.literal(1).optional().catch(undefined),
  keepAwake: z.literal(1).optional().catch(undefined),
  stallProcessSampling: z.literal(1).optional().catch(undefined),
  openCodeMajor: z.union([z.literal(1), z.literal(2)]).optional(),
  claudeSpawnPolicy: z.union([z.literal(1), z.literal(2)]).optional().catch(undefined), // Malformed reads as absent: policy-bearing Claude is refused.
  codexSpawnMetadata: z.literal(1).optional().catch(undefined),
  codexHelperPolicy: z.literal(1).optional().catch(undefined),
  queuePushGuard: z.literal(1).optional().catch(undefined), // Malformed reads as absent: queue sessions are refused.
  hasBrowserRuntime: z.boolean(),
  hasBrowserMcp: z.boolean(),
  browserAutomation: z.object({
    enabled: z.boolean(),
    headless: z.boolean(),
    profileDir: z.string(),
    // Older workers omit `running`; default keeps their heartbeats valid.
    running: z.boolean().optional().default(false),
  }).optional(),
  hasExtensionRelay: z.boolean().optional().default(false),
  extensionRelay: WorkerNodeExtensionRelaySummarySchema.optional(),
  hasAndroidMcp: z.boolean().optional().default(false),
  androidAutomation: z.object({
    enabled: z.boolean(),
    sdkPath: z.string(),
    adbVersion: z.string().optional(),
    avds: z.array(z.string()),
    connectedDevices: z.array(z.object({
      serial: z.string(),
      kind: z.enum(['emulator', 'usb', 'wifi']),
      model: z.string().optional(),
      apiLevel: z.number().int().positive().optional(),
      state: z.enum(['device', 'offline', 'unauthorized']),
    })),
    emulatorRunning: z.boolean(),
    hasMaestro: z.boolean(),
    defaultAvd: z.string().optional(),
    headlessEmulator: z.boolean().optional(),
    maxEmulators: z.number().int().positive().max(4).optional(),
    bootTimeoutMs: z.number().int().positive().optional(),
    allowPhysicalDevices: z.boolean().optional(),
    injectMaestroMcp: z.boolean().optional(),
    appiumMcp: z.boolean().optional(),
    mobileMcpVersion: z.string().optional(),
  }).optional(),
  iosAutomation: IosAutomationSchema,
  hostReadiness: HostReadinessSchema,
  connectionNotice: z.string().max(500).optional().catch(undefined),
  hasDocker: z.boolean(),
  accountProfileIds: WorkerAccountProfileIdsSchema,
  signIns: WorkerSignInsSchema,
  maxConcurrentInstances: z.number().int().positive(),
  workingDirectories: z.array(z.string()),
  browsableRoots: z.array(z.string()).default([]),
  fileTransfer: z.object({
    enabled: z.boolean(),
    maxFileBytes: z.number().int().positive().max(50 * 1024 * 1024),
    roots: z.array(z.object({
      id: z.string().min(1).max(100),
      label: z.string().min(1).max(200),
      path: z.string().min(1).max(4096),
      read: z.boolean(),
      write: z.boolean(),
      approvalRequired: z.boolean().optional(),
    })).max(64),
  }).optional(),
  discoveredProjects: z.array(z.object({
    path: z.string(),
    name: z.string(),
    markers: z.array(z.string()),
  })).default([]),
  localModelEndpoints: z.array(WorkerLocalModelCapabilitySchema)
    .max(AUXILIARY_WORKER_ENDPOINT_MAX_DESCRIPTORS)
    .optional(),
  localSttEndpoints: z.array(z.object({
    provider: z.enum(['openai-compatible', 'whisper-cli']),
    baseUrl: z.string(),
    models: z.array(z.string()),
    healthy: z.boolean(),
  })).optional(),
  hostHealth: WorkerHostHealthSampleSchema,
});

// -- Node -> Coordinator schemas -----------------------------------------------
export const NodeRegisterParamsSchema = z.object({
  nodeId: z.string().uuid(),
  name: z.string().min(1).max(100),
  capabilities: WorkerNodeCapabilitiesSchema,
  token: z.string().optional(),
  address: z.string().optional(),
});

export const NodeHeartbeatParamsSchema = z.object({
  nodeId: z.string().min(1),
  capabilities: WorkerNodeCapabilitiesSchema,
  activeInstances: z.number().int().nonnegative(),
  token: z.string().optional(),
});

export const InstanceOutputParamsSchema = z.object({
  instanceId: z.string().min(1),
  message: z.unknown(),
  token: z.string().optional(),
});

export const InstanceHeartbeatParamsSchema = z.object({
  instanceId: z.string().min(1),
  token: z.string().optional(),
});

export const InstanceCompleteParamsSchema = z.object({
  instanceId: z.string().min(1),
  response: z.unknown(),
  token: z.string().optional(),
});

export const InstanceStateChangeParamsSchema = z.object({
  instanceId: z.string().min(1),
  state: z.string().min(1),
  info: z.unknown().optional(),
  token: z.string().optional(),
});

export const InstancePermissionRequestParamsSchema = z.object({
  instanceId: z.string().min(1),
  permission: z.unknown(),
  token: z.string().optional(),
});

// -- Coordinator -> Node schemas -----------------------------------------------

export const InstanceSendInputParamsSchema = z.object({
  instanceId: z.string().min(1),
  message: z.string().min(1),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  nativeCommandId: z.string().regex(/^acp:opencode:[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,100}$/).optional(),
});

export const InstanceIdParamsSchema = z.object({
  instanceId: z.string().min(1),
});

// -- Terminal schemas (Piece C) -----------------------------------------------
//
// Coordinator -> Node requests. These are validated on the WORKER side before
// touching node-pty. `cwd` MUST additionally be sandboxed by the worker to its
// allowed working directories — the schema only enforces shape, not policy.
// `cols`/`rows` are bounded to keep a hostile/buggy client from requesting an
// absurd PTY size.

const TERMINAL_DIMENSION = z.number().int().positive().max(10_000);

export const TerminalCreateParamsSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: TERMINAL_DIMENSION.optional(),
  rows: TERMINAL_DIMENSION.optional(),
});

export const TerminalInputParamsSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

export const TerminalResizeParamsSchema = z.object({
  sessionId: z.string().min(1),
  cols: TERMINAL_DIMENSION,
  rows: TERMINAL_DIMENSION,
});

export const TerminalKillParamsSchema = z.object({
  sessionId: z.string().min(1),
  signal: z.string().min(1).optional(),
});

// Node -> Coordinator notifications. `data` is raw PTY bytes decoded to a
// string by the worker; `seq` lets the coordinator drop stale frames after a
// reconnect (mirrors the instance.* seq guard).
export const TerminalOutputParamsSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
  seq: z.number().int().nonnegative().optional(),
  token: z.string().optional(),
});

export const TerminalExitParamsSchema = z.object({
  sessionId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  token: z.string().optional(),
});

export const ProviderDiagnoseParamsSchema = z.object({
  provider: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode']),
});

// -- Node config update (privileged: scope=service) ---------------------------
//
// Coordinator -> Node. Currently scoped to the opt-in browser-automation block.
// The worker validates this, merges it into its on-disk config, persists, and
// re-applies (reconfigures the managed Chrome + re-reports capabilities). This
// is a SENSITIVE capability (it turns on an ungoverned automation surface), so
// the worker MUST require scope=service before acting.

export const BrowserAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  profileDir: z.string().min(1).max(1024).optional(),
  headless: z.boolean().optional(),
  chromePath: z.string().min(1).max(1024).optional(),
  remoteDebuggingPort: z.number().int().min(1).max(65535).optional(),
});

export const AndroidAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  sdkPath: z.string().min(1).max(1024).optional(),
  defaultAvd: z.string().min(1).max(256).optional(),
  headlessEmulator: z.boolean().optional(),
  maxEmulators: z.number().int().min(1).max(4).optional(),
  bootTimeoutMs: z.number().int().positive().optional(),
  allowPhysicalDevices: z.boolean().optional(),
  injectMaestroMcp: z.boolean().optional(),
  appiumMcp: z.boolean().optional(),
  mobileMcpVersion: z.string().min(1).max(128).optional(),
});

export const ExtensionRelayConfigSchema = z.object({
  enabled: z.boolean(),
});

export const FileTransferRootConfigSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(4096),
  read: z.boolean(),
  write: z.boolean(),
  approvalRequired: z.boolean().optional(),
}).strict();

export const FileTransferConfigSchema = z.object({
  enabled: z.boolean(),
  roots: z.array(FileTransferRootConfigSchema).max(64).optional(),
  maxFileBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
}).strict();

export const ConfigUpdateParamsSchema = z.object({
  browserAutomation: BrowserAutomationConfigSchema.optional(),
  androidAutomation: AndroidAutomationConfigSchema.optional(),
  extensionRelay: ExtensionRelayConfigSchema.optional(),
  fileTransfer: FileTransferConfigSchema.optional(),
});

// -- Remote browser CDP tunnel (Path 2; privileged: scope=service) ------------
//
// The coordinator's gateway drives a node's Chrome by tunneling raw CDP frames
// over the worker connection. `frame` is a CDP JSON-RPC message (opaque string);
// `sessionId` correlates one puppeteer transport ↔ one Chrome CDP socket.

export const BrowserCdpOpenParamsSchema = z.object({
  sessionId: z.string().min(1).max(128),
});

export const BrowserCdpSendParamsSchema = z.object({
  sessionId: z.string().min(1).max(128),
  // CDP frames are bounded but can be large (e.g. screenshot results); cap to a
  // generous ceiling to reject pathological payloads without truncating valid ones.
  frame: z.string().refine(
    (frame) => Buffer.byteLength(frame, 'utf8') <= BROWSER_CDP_MAX_FRAME_BYTES,
    { message: `CDP frame exceeds ${BROWSER_CDP_MAX_FRAME_BYTES} bytes` },
  ),
});

export const BrowserCdpCloseParamsSchema = z.object({
  sessionId: z.string().min(1).max(128),
});

// -- Remote browser extension relay (Path 3) ----------------------------------
//
// Worker native hosts forward extension traffic over the authenticated worker
// socket. The coordinator assigns node identity from the connection; nodeId is
// intentionally not accepted from these payloads.

const BrowserExtensionRuntimeEvidenceSchema = {
  extensionVersion: z.string().min(1).max(128).optional(),
  extensionStartedAt: z.number().int().nonnegative().optional(),
  // One install = one Chrome profile. Bounded here; format checked where used (bad format → no id).
  extensionInstanceId: z.string().min(1).max(128).optional(),
} as const;

export const BrowserExtAttachTabParamsSchema = z.object({
  ...BrowserExtensionRuntimeEvidenceSchema,
  token: z.string().optional(),
  extensionOrigin: z.string().min(1).max(200).optional(),
  // Tolerates an install id nested by an older relay (see the helper).
  payload: z.preprocess(withoutNestedExtensionInstanceId, BrowserAttachExistingTabRequestSchema),
});

export const BrowserExtPollCommandParamsSchema = z.object({
  ...BrowserExtensionRuntimeEvidenceSchema,
  token: z.string().optional(),
  extensionOrigin: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(0).max(10_000).optional(),
});

export const BrowserExtCommandResultParamsSchema = z.object({
  ...BrowserExtensionRuntimeEvidenceSchema,
  token: z.string().optional(),
  extensionOrigin: z.string().min(1).max(200).optional(),
  commandId: z.string().min(1).max(200),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().min(1).max(2000).optional(),
});

export const BrowserExtCommandReceivedParamsSchema = z.object({
  ...BrowserExtensionRuntimeEvidenceSchema,
  token: z.string().optional(),
  extensionOrigin: z.string().min(1).max(200).optional(),
  commandId: z.string().min(1).max(200),
});

export const BrowserExtDisconnectedParamsSchema = z.object({
  ...BrowserExtensionRuntimeEvidenceSchema,
  token: z.string().optional(),
  extensionOrigin: z.string().min(1).max(200).optional(),
  reason: z.string().min(1).max(200).optional(),
});

/** No params — stop the managed Chrome on the node. */
export const BrowserStopManagedParamsSchema = z.object({});

export const AuxiliaryModelListParamsSchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible']),
});

export const AuxiliaryModelGenerateParamsSchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible']),
  model: z.string().min(1),
  systemPrompt: z.string(),
  userPrompt: z.string(),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  requireJson: z.boolean(),
  // Optional Ollama context window (tokens). Older coordinators omit it; the
  // worker then falls back to Ollama's default. Ignored for openai-compatible.
  numCtx: z.number().int().positive().optional(),
});

const AUDIO_TRANSCRIBE_AUDIO_BASE64_MAX_LENGTH = 16 * 1024 * 1024;
const AudioTranscribeBaseParamsSchema = z.object({
  model: z.string().min(1),
  language: z.string().trim().min(2).max(16),
  task: z.enum(['transcribe', 'translate']),
  audioBase64: z.string().min(1).max(AUDIO_TRANSCRIBE_AUDIO_BASE64_MAX_LENGTH),
  sampleRate: z.number().int().positive().max(192000),
  timeoutMs: z.number().int().positive(),
});

export const AudioTranscribeParamsSchema = z.discriminatedUnion('provider', [
  AudioTranscribeBaseParamsSchema.extend({
    provider: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
  }),
  AudioTranscribeBaseParamsSchema.extend({
    provider: z.literal('whisper-cli'),
    baseUrl: z.string().url().optional(),
  }),
]);

const LocalAiExpectedModelRpcSchema = z.object({
  modelId: LocalAiModelIdSchema,
  required: z.boolean(),
  minContextLength: z.number()
    .finite()
    .int()
    .min(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.min)
    .max(LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength.max)
    .optional(),
  routingRoles: z.array(LocalAiRoutingRoleSchema).max(50).optional(),
}).strict();

const LocalAiCanaryContractSchema = z.object({
  contract: z.literal('exact-token-v1'),
  model: LocalAiModelIdSchema,
}).strict();

const localAiHealthBaseFields = {
  provider: LocalModelEndpointProviderSchema,
  endpointId: LocalAiEndpointIdSchema,
  expectedModels: z.array(LocalAiExpectedModelRpcSchema).min(1).max(100),
  canary: LocalAiCanaryContractSchema,
  latencyThresholdMs: z.number().int().positive().max(LOCAL_AI_HEALTH_MAX_LATENCY_THRESHOLD_MS),
  timeoutMs: z.number().int().positive().max(LOCAL_AI_HEALTH_MAX_TIMEOUT_MS),
} as const;

function validateLocalAiHealthTarget(
  value: {
    provider: 'ollama' | 'openai-compatible';
    endpointId: string;
    expectedModels: { modelId: string }[];
    canary: { model: string };
  },
  context: z.RefinementCtx,
): void {
  const expectedEndpointId = value.provider === 'ollama' ? 'ollama' : 'openai-compatible';
  if (value.endpointId !== expectedEndpointId) {
    context.addIssue({
      code: 'custom',
      path: ['endpointId'],
      message: `Endpoint ID must match the worker-local ${value.provider} endpoint`,
    });
  }
  if (!value.expectedModels.some((expected) => expected.modelId === value.canary.model)) {
    context.addIssue({
      code: 'custom',
      path: ['canary', 'model'],
      message: 'Canary model must be present in expectedModels',
    });
  }
  if (new Set(value.expectedModels.map((expected) => expected.modelId)).size !== value.expectedModels.length) {
    context.addIssue({
      code: 'custom',
      path: ['expectedModels'],
      message: 'Expected models must be unique',
    });
  }
}

export const LocalAiHealthCheckParamsSchema = z.object({
  ...localAiHealthBaseFields,
  kind: z.enum(['lightweight', 'functional']),
}).strict().superRefine(validateLocalAiHealthTarget);

export const LocalAiHealthDiagnoseParamsSchema = z.object({
  ...localAiHealthBaseFields,
}).strict().superRefine(validateLocalAiHealthTarget);

export const LocalAiHealthRepairParamsSchema = z.object({
  provider: LocalModelEndpointProviderSchema,
  endpointId: LocalAiEndpointIdSchema,
  action: LocalAiRepairActionSchema,
}).strict().superRefine((value, context) => {
  const expectedEndpointId = value.provider === 'ollama' ? 'ollama' : 'openai-compatible';
  if (value.endpointId !== expectedEndpointId) {
    context.addIssue({
      code: 'custom',
      path: ['endpointId'],
      message: `Endpoint ID must match the worker-local ${value.provider} endpoint`,
    });
  }
});

const LocalAiHealthMetadataProbeResultSchema = LocalAiProbeResultSchema
  .superRefine((sample, context) => {
    if (!['endpoint', 'model', 'inference'].includes(sample.layer)) {
      context.addIssue({
        code: 'custom',
        path: ['layer'],
        message: 'Worker Local AI checks may return endpoint, model, and inference metadata only',
      });
    }
  });

export const LocalAiHealthCheckResultSchema = z.array(LocalAiHealthMetadataProbeResultSchema)
  .min(1)
  .max(3);

export const LocalAiHealthDiagnoseResultSchema = LocalAiDiagnosticReportSchema
  .safeExtend({
    samples: z.array(LocalAiHealthMetadataProbeResultSchema).min(1).max(3),
    recommendedActions: z.array(LocalAiRepairActionSchema).max(5),
  });

export const LocalAiHealthRepairResultSchema = LocalAiRepairResultSchema;

export const LocalModelSessionStartParamsSchema = z.object({
  sessionId: z.string().min(1).max(200),
  endpointProvider: LocalModelEndpointProviderSchema,
  endpointId: z.string().min(1).max(128),
  modelId: ProviderModelIdSchema.min(1),
  workingDirectory: z.string().min(1).max(4096).optional(),
  systemPrompt: z.string().max(200_000).optional(),
});

export const LocalModelSessionSendInputParamsSchema = z.object({
  sessionId: z.string().min(1).max(200),
  message: z.string().min(1).max(1_000_000),
  attachments: z.array(FileAttachmentSchema.extend({ data: z.string() })).max(64).optional(),
});

/** WS15 — durable-stream resume: replay everything after each cursor. */
export const StreamResumeParamsSchema = z.object({
  cursors: z.array(z.object({
    instanceId: z.string().min(1).max(200),
    afterSeq: z.number().int().min(0),
  })).max(500),
});

/** WS15 — durable-stream ack: the coordinator has processed through seq. */
export const StreamAckParamsSchema = z.object({
  cursors: z.array(z.object({
    instanceId: z.string().min(1).max(200),
    seq: z.number().int().min(1),
  })).max(500),
});

export const LocalModelSessionIdParamsSchema = z.object({
  sessionId: z.string().min(1).max(200),
});

/** The coordinator's current reachable ws/wss URLs, best-first (privileged: scope=service). */
export const CoordinatorAddressesParamsSchema = z.object({
  urls: z.array(z.string().regex(/^wss?:\/\/[^\s]+$/).max(512)).min(1).max(16),
});

// -- Schema map for method-based lookup ---------------------------------------

export const RPC_PARAM_SCHEMAS: Record<string, z.ZodType> = {
  'node.register': NodeRegisterParamsSchema,
  'node.heartbeat': NodeHeartbeatParamsSchema,
  'instance.heartbeat': InstanceHeartbeatParamsSchema,
  'instance.complete': InstanceCompleteParamsSchema,
  'instance.stateChange': InstanceStateChangeParamsSchema,
  'instance.permissionRequest': InstancePermissionRequestParamsSchema,
  'browser.ext.attachTab': BrowserExtAttachTabParamsSchema,
  'browser.ext.pollCommand': BrowserExtPollCommandParamsSchema,
  'browser.ext.commandResult': BrowserExtCommandResultParamsSchema,
  'browser.ext.commandReceived': BrowserExtCommandReceivedParamsSchema,
  'browser.ext.disconnected': BrowserExtDisconnectedParamsSchema,
  'instance.spawn': InstanceSpawnParamsSchema,
  'instance.changeModel': InstanceChangeModelParamsSchema,
  'instance.sampleStallProcess': InstanceSampleStallProcessParamsSchema,
  'node.keepAwake': NodeKeepAwakeParamsSchema,
  'instance.sendInput': InstanceSendInputParamsSchema, 'instance.sendRaw': InstanceSendRawParamsSchema,
  'instance.terminate': InstanceIdParamsSchema,
  'instance.interrupt': InstanceIdParamsSchema,
  'instance.hibernate': InstanceIdParamsSchema,
  'instance.wake': InstanceIdParamsSchema,
  'localModel.session.start': LocalModelSessionStartParamsSchema,
  'localModel.session.sendInput': LocalModelSessionSendInputParamsSchema,
  'localModel.session.terminate': LocalModelSessionIdParamsSchema,
  'localModel.session.interrupt': LocalModelSessionIdParamsSchema,
  'fs.readDirectory': FsReadDirectoryParamsSchema,
  'fs.stat': FsStatParamsSchema,
  'fs.search': FsSearchParamsSchema,
  'fs.watch': FsWatchParamsSchema,
  'fs.unwatch': FsUnwatchParamsSchema,
  'fs.readFile': FsReadFileParamsSchema,
  'fs.writeFile': FsWriteFileParamsSchema,
  'fs.event': FsEventParamsSchema,
};

/**
 * Coordinator -> Node request param schemas, keyed by method. The worker-agent
 * validates inbound requests against these before acting (the coordinator's own
 * router uses RPC_PARAM_SCHEMAS above for node -> coordinator traffic). Terminal
 * methods are safety-relevant — the worker MUST also sandbox `cwd` to its
 * allowed directories after schema validation passes.
 */
export const COORDINATOR_TO_NODE_PARAM_SCHEMAS: Record<string, z.ZodType> = {
  'instance.spawn': InstanceSpawnParamsSchema,
  'instance.changeModel': InstanceChangeModelParamsSchema,
  'instance.sampleStallProcess': InstanceSampleStallProcessParamsSchema,
  'node.keepAwake': NodeKeepAwakeParamsSchema,
  'instance.sendInput': InstanceSendInputParamsSchema, 'instance.sendRaw': InstanceSendRawParamsSchema,
  'instance.terminate': InstanceIdParamsSchema,
  'instance.interrupt': InstanceIdParamsSchema,
  'instance.hibernate': InstanceIdParamsSchema,
  'instance.wake': InstanceIdParamsSchema,
  'localModel.session.start': LocalModelSessionStartParamsSchema,
  'localModel.session.sendInput': LocalModelSessionSendInputParamsSchema,
  'localModel.session.terminate': LocalModelSessionIdParamsSchema,
  'localModel.session.interrupt': LocalModelSessionIdParamsSchema,
  'terminal.create': TerminalCreateParamsSchema,
  'terminal.input': TerminalInputParamsSchema,
  'terminal.resize': TerminalResizeParamsSchema,
  'terminal.kill': TerminalKillParamsSchema,
  'provider.diagnose': ProviderDiagnoseParamsSchema,
  'node.exec': NodeExecParamsSchema,
  'fs.readFile': FsReadFileParamsSchema,
  'fs.writeFile': FsWriteFileParamsSchema,
  'config.update': ConfigUpdateParamsSchema,
  'node.coordinatorAddresses': CoordinatorAddressesParamsSchema,
  'browser.cdp.open': BrowserCdpOpenParamsSchema,
  'browser.cdp.send': BrowserCdpSendParamsSchema,
  'browser.cdp.close': BrowserCdpCloseParamsSchema,
  'browser.stopManaged': BrowserStopManagedParamsSchema,
  'browser.extension.recover': BrowserExtensionRecoverParamsSchema,
  'auxiliaryModel.list': AuxiliaryModelListParamsSchema,
  'auxiliaryModel.generate': AuxiliaryModelGenerateParamsSchema,
  'audio.transcribe': AudioTranscribeParamsSchema,
  'localAi.health.check': LocalAiHealthCheckParamsSchema,
  'localAi.health.diagnose': LocalAiHealthDiagnoseParamsSchema,
  'localAi.health.repair': LocalAiHealthRepairParamsSchema,
};

/**
 * Validate RPC params against a Zod schema. Throws with a descriptive
 * error message if validation fails.
 */
export function validateRpcParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new Error(`RPC validation failed: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}
