import { z } from 'zod';

const WorkspacePathSchema = z.string().min(1).max(4000).optional();
const PositiveLimitSchema = z.number().int().min(1).max(500).optional();

export const CodememFindSymbolArgsSchema = z.object({
  workspacePath: WorkspacePathSchema,
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(50).optional(),
  limit: PositiveLimitSchema,
});

export const CodememWorkspaceSymbolsArgsSchema = z.object({
  workspacePath: WorkspacePathSchema,
  query: z.string().min(1).max(200),
  limit: PositiveLimitSchema,
});

export const CodememSymbolLookupArgsSchema = z.object({
  workspacePath: WorkspacePathSchema,
  symbolId: z.string().min(1).max(100),
});

export const CodememFindReferencesArgsSchema = CodememSymbolLookupArgsSchema.extend({
  limit: PositiveLimitSchema,
});

export const CodememCallHierarchyArgsSchema = CodememSymbolLookupArgsSchema.extend({
  direction: z.enum(['incoming', 'outgoing']),
  maxDepth: z.number().int().min(1).max(5).optional(),
});

export const CodememDocumentSymbolsArgsSchema = z.object({
  path: z.string().min(1).max(4000),
});

export const CodememDiagnosticsArgsSchema = z.object({
  path: z.string().min(1).max(4000),
  page: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
});
