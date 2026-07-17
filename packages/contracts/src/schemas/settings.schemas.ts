import { z } from 'zod';
import { WorkingDirectorySchema, FilePathSchema } from './common.schemas';

// ============ Settings ============

export const SettingsGetPayloadSchema = z.object({
  key: z.string().min(1).max(100),
});

const RequiredSettingsValueSchema = z.unknown().refine((value) => value !== undefined, {
  message: 'Value is required',
});

export const SettingsUpdatePayloadSchema = z.object({
  key: z.string().min(1).max(100),
  value: RequiredSettingsValueSchema, // Settings can be various types
});

export const SettingsBulkUpdatePayloadSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
}).passthrough(); // Allow direct settings as well

export const SettingsResetOnePayloadSchema = z.object({
  key: z.string().min(1).max(100),
});

// NOTE: SettingsUpdatePayload interface already defined in transport.types.ts

export const SettingsSetPayloadSchema = z.object({
  key: z.string().min(1).max(100),
  value: RequiredSettingsValueSchema,
});

// ============ Settings MCP Tools ============

const SettingsToolKeySchema = z.string().min(1).max(100);

export const SettingsToolListPayloadSchema = z.object({
  category: z.string().trim().min(1).max(64).optional(),
}).strict();

export const SettingsToolGetPayloadSchema = z.object({
  key: SettingsToolKeySchema,
}).strict();

export const SettingsToolSetPayloadSchema = z.object({
  key: SettingsToolKeySchema,
  value: RequiredSettingsValueSchema,
}).strict();

export const SettingsToolResetPayloadSchema = z.object({
  key: SettingsToolKeySchema,
}).strict();

export const SettingsPrivilegedListPayloadSchema = SettingsToolListPayloadSchema.extend({
  all: z.boolean().optional(),
}).strict();

export const SettingsPrivilegedGetPayloadSchema = SettingsToolGetPayloadSchema;
export const SettingsPrivilegedSetPayloadSchema = SettingsToolSetPayloadSchema;
export const SettingsPrivilegedResetPayloadSchema = SettingsToolResetPayloadSchema;

const SettingsToolBrowserAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  profileDir: z.string().trim().min(1).max(1024).optional(),
  headless: z.boolean().optional(),
  chromePath: z.string().trim().min(1).max(1024).optional(),
  remoteDebuggingPort: z.number().int().min(1).max(65535).optional(),
}).strict();

const SettingsToolAndroidAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  sdkPath: z.string().trim().min(1).max(1024).optional(),
  defaultAvd: z.string().trim().min(1).max(256).optional(),
  headlessEmulator: z.boolean().optional(),
  maxEmulators: z.number().int().min(1).max(4).optional(),
  bootTimeoutMs: z.number().int().min(10_000).max(600_000).optional(),
  allowPhysicalDevices: z.boolean().optional(),
  injectMaestroMcp: z.boolean().optional(),
  appiumMcp: z.boolean().optional(),
  mobileMcpVersion: z.string().trim().min(1).max(128).optional(),
}).strict();

const SettingsToolExtensionRelayConfigSchema = z.object({
  enabled: z.boolean(),
}).strict();

const SettingsToolFileTransferRootSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(4096),
  read: z.boolean(),
  write: z.boolean(),
  approvalRequired: z.boolean().optional(),
}).strict();

const SettingsToolFileTransferConfigSchema = z.object({
  enabled: z.boolean(),
  roots: z.array(SettingsToolFileTransferRootSchema).max(64).optional(),
  maxFileBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
}).strict();

export const SettingsToolUpdateNodeConfigPayloadSchema = z.object({
  nodeId: z.string().trim().min(1).max(200),
  browserAutomation: SettingsToolBrowserAutomationConfigSchema.optional(),
  androidAutomation: SettingsToolAndroidAutomationConfigSchema.optional(),
  extensionRelay: SettingsToolExtensionRelayConfigSchema.optional(),
  fileTransfer: SettingsToolFileTransferConfigSchema.optional(),
}).strict().refine(
  (payload) =>
    payload.browserAutomation !== undefined ||
    payload.androidAutomation !== undefined ||
    payload.extensionRelay !== undefined ||
    payload.fileTransfer !== undefined,
  {
    message:
      'Provide at least one config block: browserAutomation, androidAutomation, extensionRelay, or fileTransfer.',
  },
);

// ============ Config ============

const ConfigPathSchema = z.string().min(1).max(2000);

export const ConfigResolvePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const ConfigGetProjectPayloadSchema = z.object({
  configPath: ConfigPathSchema,
});

export const ConfigSaveProjectPayloadSchema = z.object({
  configPath: ConfigPathSchema,
  config: z.record(z.string(), z.unknown()), // ProjectConfig is complex, validate structure
});

export const ConfigCreateProjectPayloadSchema = z.object({
  projectDir: WorkingDirectorySchema,
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ConfigFindProjectPayloadSchema = z.object({
  startDir: WorkingDirectorySchema,
});

export const InstructionTrustApprovePayloadSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1).max(4000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1).max(50),
});

export const InstructionTrustRevokePayloadSchema = z.object({
  path: z.string().min(1).max(4000),
});

export const InstructionsResolvePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  contextPaths: z.array(FilePathSchema).max(500).optional(),
});

export const InstructionsCreateDraftPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  contextPaths: z.array(FilePathSchema).max(500).optional(),
});

// ============ Remote Config ============

const UrlSchema = z.string().url().max(2000);
const DomainSchema = z.string().min(1).max(255);
const GitHubOwnerSchema = z.string().min(1).max(100);
const GitHubRepoSchema = z.string().min(1).max(100);

export const RemoteConfigFetchUrlPayloadSchema = z.object({
  url: UrlSchema,
  timeout: z.number().int().min(0).max(60000).optional(),
  cacheTTL: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  useCache: z.boolean().optional(),
});

export const RemoteConfigFetchWellKnownPayloadSchema = z.object({
  domain: DomainSchema,
  timeout: z.number().int().min(0).max(60000).optional(),
  cacheTTL: z.number().int().min(0).optional(),
});

export const RemoteConfigFetchGitHubPayloadSchema = z.object({
  owner: GitHubOwnerSchema,
  repo: GitHubRepoSchema,
  branch: z.string().max(100).optional(),
});

export const RemoteConfigDiscoverGitPayloadSchema = z.object({
  gitRemoteUrl: UrlSchema,
});

export const RemoteConfigInvalidatePayloadSchema = z.object({
  url: UrlSchema,
});

export const RemoteObserverStartPayloadSchema = z.object({
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
