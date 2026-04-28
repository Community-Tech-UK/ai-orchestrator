import { z } from 'zod';
import {
  FilePathSchema,
  DirectoryPathSchema,
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
  model: z.string().max(200).optional(),
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
