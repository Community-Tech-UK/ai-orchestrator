import { z } from 'zod/v4';
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema,
  FsEventParamsSchema,
} from '../../shared/validation/remote-fs-schemas';
import { FileAttachmentSchema } from '@contracts/schemas/common';

// -- Shared sub-schemas -------------------------------------------------------

const WorkerNodeCapabilitiesSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.string(),
  cpuCores: z.number().int().positive(),
  totalMemoryMB: z.number().int().positive(),
  availableMemoryMB: z.number().int().nonnegative(),
  gpuName: z.string().optional(),
  gpuMemoryMB: z.number().int().optional(),
  supportedClis: z.array(z.string()),
  hasBrowserRuntime: z.boolean(),
  hasBrowserMcp: z.boolean(),
  hasDocker: z.boolean(),
  maxConcurrentInstances: z.number().int().positive(),
  workingDirectories: z.array(z.string()),
  browsableRoots: z.array(z.string()).default([]),
  discoveredProjects: z.array(z.object({
    path: z.string(),
    name: z.string(),
    markers: z.array(z.string()),
  })).default([]),
  localModelEndpoints: z.array(z.object({
    provider: z.enum(['ollama', 'openai-compatible']),
    baseUrl: z.string(),
    models: z.array(z.string()),
    healthy: z.boolean(),
  })).optional(),
});

// -- Node -> Coordinator schemas -----------------------------------------------

export const NodeRegisterParamsSchema = z.object({
  nodeId: z.string().uuid(),
  name: z.string().min(1).max(100),
  capabilities: WorkerNodeCapabilitiesSchema,
  token: z.string().optional(),
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

export const InstanceSpawnParamsSchema = z.object({
  instanceId: z.string().min(1),
  cliType: z.string().min(1),
  workingDirectory: z.string().min(1),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  yoloMode: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  resume: z.boolean().optional(),
  forkSession: z.boolean().optional(),
  mcpConfig: z.array(z.string()).optional(),
});

export const InstanceSendInputParamsSchema = z.object({
  instanceId: z.string().min(1),
  message: z.string().min(1),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
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
  provider: z.enum(['claude', 'codex', 'gemini', 'copilot', 'cursor']),
});

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
});

// -- Schema map for method-based lookup ---------------------------------------

export const RPC_PARAM_SCHEMAS: Record<string, z.ZodType> = {
  'node.register': NodeRegisterParamsSchema,
  'node.heartbeat': NodeHeartbeatParamsSchema,
  'instance.heartbeat': InstanceHeartbeatParamsSchema,
  'instance.complete': InstanceCompleteParamsSchema,
  'instance.stateChange': InstanceStateChangeParamsSchema,
  'instance.permissionRequest': InstancePermissionRequestParamsSchema,
  'instance.spawn': InstanceSpawnParamsSchema,
  'instance.sendInput': InstanceSendInputParamsSchema,
  'instance.terminate': InstanceIdParamsSchema,
  'instance.interrupt': InstanceIdParamsSchema,
  'instance.hibernate': InstanceIdParamsSchema,
  'instance.wake': InstanceIdParamsSchema,
  'fs.readDirectory': FsReadDirectoryParamsSchema,
  'fs.stat': FsStatParamsSchema,
  'fs.search': FsSearchParamsSchema,
  'fs.watch': FsWatchParamsSchema,
  'fs.unwatch': FsUnwatchParamsSchema,
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
  'instance.sendInput': InstanceSendInputParamsSchema,
  'instance.terminate': InstanceIdParamsSchema,
  'instance.interrupt': InstanceIdParamsSchema,
  'instance.hibernate': InstanceIdParamsSchema,
  'instance.wake': InstanceIdParamsSchema,
  'terminal.create': TerminalCreateParamsSchema,
  'terminal.input': TerminalInputParamsSchema,
  'terminal.resize': TerminalResizeParamsSchema,
  'terminal.kill': TerminalKillParamsSchema,
  'provider.diagnose': ProviderDiagnoseParamsSchema,
  'auxiliaryModel.list': AuxiliaryModelListParamsSchema,
  'auxiliaryModel.generate': AuxiliaryModelGenerateParamsSchema,
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
