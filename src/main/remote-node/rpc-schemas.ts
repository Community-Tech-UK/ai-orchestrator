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

// -- Schema map for method-based lookup ---------------------------------------

export const RPC_PARAM_SCHEMAS: Record<string, z.ZodType> = {
  'node.register': NodeRegisterParamsSchema,
  'node.heartbeat': NodeHeartbeatParamsSchema,
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
