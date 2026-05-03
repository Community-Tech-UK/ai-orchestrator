import { z } from 'zod';

// ============ Knowledge Graph Payloads ============

export const KgAddFactPayloadSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceCloset: z.string().optional(),
  sourceFile: z.string().optional(),
});

export const KgInvalidateFactPayloadSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  ended: z.string().optional(),
});

export const KgQueryEntityPayloadSchema = z.object({
  entityName: z.string().min(1),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
  asOf: z.string().optional(),
});

export const KgQueryRelationshipPayloadSchema = z.object({
  predicate: z.string().min(1),
  asOf: z.string().optional(),
});

export const KgTimelinePayloadSchema = z.object({
  entityName: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const KgAddEntityPayloadSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

// ============ Conversation Mining Payloads ============

export const ConvoImportFilePayloadSchema = z.object({
  filePath: z.string().min(1),
  wing: z.string().min(1),
});

export const ConvoImportStringPayloadSchema = z.object({
  content: z.string().min(1),
  wing: z.string().min(1),
  sourceFile: z.string().min(1),
  format: z.enum([
    'claude-code-jsonl', 'codex-jsonl', 'claude-ai-json',
    'chatgpt-json', 'slack-json', 'plain-text',
  ]).optional(),
});

export const ConvoDetectFormatPayloadSchema = z.object({
  content: z.string().min(1),
});

// ============ Wake Context Payloads ============

export const WakeGeneratePayloadSchema = z.object({
  wing: z.string().optional(),
});

export const WakeAddHintPayloadSchema = z.object({
  content: z.string().min(1),
  importance: z.number().min(0).max(10).optional(),
  room: z.string().optional(),
  sourceReflectionId: z.string().optional(),
  sourceSessionId: z.string().optional(),
});

export const WakeRemoveHintPayloadSchema = z.object({
  id: z.string().min(1),
});

export const WakeSetIdentityPayloadSchema = z.object({
  text: z.string().min(1).max(500),
});

export const WakeListHintsPayloadSchema = z.object({
  room: z.string().optional(),
});

// ============ Codebase Mining Payloads ============

export const CodebaseMineDirectoryPayloadSchema = z.object({
  dirPath: z.string().min(1),
});

export const CodebaseGetStatusPayloadSchema = z.object({
  dirPath: z.string().min(1),
});

export const CodebasePauseProjectPayloadSchema = z.object({
  dirPath: z.string().min(1),
});

export const CodebaseResumeProjectPayloadSchema = z.object({
  dirPath: z.string().min(1),
});

export const CodebaseExcludeProjectPayloadSchema = z.object({
  dirPath: z.string().min(1),
});

// ============ Project Knowledge Payloads ============

export const ProjectKnowledgeGetReadModelPayloadSchema = z.object({
  projectKey: z.string().min(1),
});

export const ProjectKnowledgeGetEvidencePayloadSchema = z.object({
  projectKey: z.string().min(1),
  targetKind: z.enum(['kg_triple', 'wake_hint', 'code_symbol']),
  targetId: z.string().min(1),
});

export const ProjectKnowledgeRefreshCodeIndexPayloadSchema = z.object({
  projectKey: z.string().min(1),
});
