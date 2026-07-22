import { z } from 'zod';
import {
  FilePathSchema,
  DirectoryPathSchema,
  ModelIdSchema,
  WorkingDirectorySchema,
} from './common.schemas';

// ============ Debug & Log Payloads ============

const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);

export const LogGetRecentPayloadSchema = z.object({
  limit: z.number().int().min(1).max(10000).optional(),
  level: LogLevelSchema.optional(),
  subsystem: z.string().max(100).optional(),
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
}).optional();

export const LogSetLevelPayloadSchema = z.object({
  level: LogLevelSchema,
});

export const LogSetSubsystemLevelPayloadSchema = z.object({
  subsystem: z.string().min(1).max(100),
  level: LogLevelSchema,
});

export const LogExportPayloadSchema = z.object({
  filePath: FilePathSchema,
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
});

export const DebugAgentPayloadSchema = z.object({
  agentId: z.string().min(1).max(200),
});

export const DebugConfigPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const DebugFilePayloadSchema = z.object({
  filePath: FilePathSchema,
});

export const DebugAllPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

// ============ Renderer Telemetry ============

/** Renderer→main log forwarding (RendererErrorHandler and friends). */
export const RendererLogMessagePayloadSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().max(10_000),
  context: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Renderer main-thread heartbeat; beats stop exactly when the UI thread blocks. */
export const RendererHeartbeatPayloadSchema = z.object({
  seq: z.number().int().nonnegative(),
  sentAt: z.number().int().nonnegative(),
});

export const MemoryStatsEventSchema = z.object({
  heapUsedMB: z.number().nonnegative().finite(),
  heapTotalMB: z.number().nonnegative().finite(),
  externalMB: z.number().nonnegative().finite(),
  rssMB: z.number().nonnegative().finite(),
  percentUsed: z.number().nonnegative().finite(),
}).strict();

export const MemoryAlertEventSchema = MemoryStatsEventSchema.extend({
  message: z.string().min(1).max(2_000),
});

export const StartupCapabilityReportEventSchema = z.object({
  status: z.enum(['ready', 'degraded', 'failed']),
  generatedAt: z.number().int().nonnegative(),
  checks: z.array(z.object({
    id: z.string().min(1).max(500),
    label: z.string().min(1).max(500),
    category: z.enum(['native', 'provider', 'subsystem']),
    status: z.enum(['ready', 'degraded', 'unavailable', 'disabled']),
    critical: z.boolean(),
    summary: z.string().max(10_000),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict()).max(1_000),
}).strict();

const CliUpdatePlanSummarySchema = z.object({
  cli: z.string().min(1).max(200),
  displayName: z.string().min(1).max(500),
  supported: z.boolean(),
  command: z.string().max(2_000).optional(),
  args: z.array(z.string().max(2_000)).max(100).optional(),
  displayCommand: z.string().max(10_000).optional(),
  activePath: z.string().max(10_000).optional(),
  currentVersion: z.string().max(500).optional(),
  reason: z.string().max(10_000).optional(),
  strategy: z.enum(['npm', 'bun', 'pnpm', 'self-update', 'gh-extension', 'homebrew', 'install-script']).optional(),
}).strict();

export const CliUpdatePillStateEventSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  entries: z.array(z.object({
    cli: z.string().min(1).max(200),
    displayName: z.string().min(1).max(500),
    currentVersion: z.string().max(500).optional(),
    latestVersion: z.string().max(500).optional(),
    updateAvailable: z.boolean().optional(),
    updatePlan: CliUpdatePlanSummarySchema,
  }).strict()).max(1_000),
  error: z.string().max(10_000).optional(),
}).strict();

export const UpdateStatusEventSchema = z.object({
  state: z.enum(['idle', 'checking', 'available', 'not-available', 'downloading', 'downloaded', 'error']),
  enabled: z.boolean(),
  currentVersion: z.string().max(500).optional(),
  availableVersion: z.string().max(500).optional(),
  percent: z.number().min(0).max(100).optional(),
  lastCheckedAt: z.string().max(100).optional(),
  error: z.string().max(10_000).optional(),
  errorContext: z.enum(['check', 'download', 'install']).optional(),
}).strict();

export const EmptyRendererEventSchema = z.undefined();

export const NotificationDeltaEventSchema = z.object({
  id: z.string().min(1).max(500),
  kind: z.string().min(1).max(200),
  instanceId: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(1_000),
  body: z.string().max(10_000),
  urgency: z.enum(['normal', 'critical']),
  fingerprint: z.string().min(1).max(2_000),
  createdAt: z.number().int().nonnegative(),
  delivery: z.enum([
    'desktop',
    'fingerprint-suppressed',
    'cooldown-suppressed',
    'quiet-hours',
    'desktop-unavailable',
  ]),
}).strict();

/** Push event: one skill activation was recorded (skill observability). */
export const SkillActivationDeltaEventSchema = z.object({
  id: z.string().min(1).max(500),
  skillName: z.string().min(1).max(200),
  skillSource: z.string().min(1).max(50),
  instanceId: z.string().min(1).max(200).nullable(),
  sessionId: z.string().min(1).max(200).nullable(),
  turnKey: z.string().min(1).max(500).nullable(),
  matchedBy: z.enum(['trigger', 'embedding', 'explicit']),
  matchedTrigger: z.string().max(500).nullable(),
  matchScore: z.number().nullable(),
  tokensInjected: z.number().int().nonnegative(),
  autoSelected: z.boolean(),
  createdAt: z.number().int().nonnegative(),
}).strict();

// ============ Search Payloads ============

export const SearchSemanticPayloadSchema = z.object({
  query: z.string().min(1).max(100000),
  directory: DirectoryPathSchema.optional(),
  maxResults: z.number().int().min(1).max(1000).optional(),
  includePatterns: z.array(z.string().max(500)).max(100).optional(),
  excludePatterns: z.array(z.string().max(500)).max(100).optional(),
  searchType: z.enum(['semantic', 'keyword', 'hybrid']).optional(),
});

export const SearchBuildIndexPayloadSchema = z.object({
  directory: DirectoryPathSchema,
  includePatterns: z.array(z.string().max(500)).max(100).optional(),
  excludePatterns: z.array(z.string().max(500)).max(100).optional(),
});

export const SearchConfigureExaPayloadSchema = z.object({
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(2000).optional(),
});

export const SessionRecallSearchPayloadSchema = z.object({
  query: z.string().max(10000).default(''),
  intent: z.enum([
    'general',
    'priorFailuresByProviderModel',
    'priorFixesByRepositoryPath',
    'priorDecisions',
    'stuckSessionDiagnostics',
    'automationRunHistory',
  ]).optional(),
  parentId: z.string().max(200).optional(),
  automationId: z.string().max(200).optional(),
  provider: z.string().max(100).optional(),
  model: ModelIdSchema.optional(),
  repositoryPath: z.string().max(2000).optional(),
  sources: z.array(z.enum([
    'child_result',
    'child_diagnostic',
    'automation_run',
    'provider_event',
    'agent_tree',
    'archived_session',
  ])).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** Resolve `@T-<id>` session cross-references found in a prompt. */
export const SessionRecallResolveRefPayloadSchema = z.object({
  text: z.string().min(1).max(100_000),
});
