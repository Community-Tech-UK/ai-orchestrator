import { z } from 'zod';
import type {
  EvidenceCompareInput,
  EvidenceListInput,
  EvidenceReadInput,
  EvidenceSearchInput,
  EvidenceVerifyInput,
} from '../context-evidence/evidence-retrieval-service';
import type { McpServerToolDefinition } from './mcp-server-tools';

const EvidenceIdSchema = z.string().min(1).max(256);
const ByteOffsetSchema = z.number().int().min(0);
const TokenLimitSchema = z.number().int().min(1).max(4096);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const RangeSchema = z.object({
  evidenceId: EvidenceIdSchema,
  startByte: ByteOffsetSchema,
  endByte: ByteOffsetSchema,
}).strict().refine((value) => value.endByte > value.startByte, {
  message: 'endByte must be greater than startByte',
});

export const EvidenceListToolArgsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const EvidenceSearchToolArgsSchema = z.object({
  query: z.string().trim().min(1).max(200),
  tokenLimit: TokenLimitSchema,
}).strict();

export const EvidenceReadToolArgsSchema = z.object({
  evidenceId: EvidenceIdSchema,
  startByte: ByteOffsetSchema,
  endByte: ByteOffsetSchema,
  tokenLimit: TokenLimitSchema,
}).strict().refine((value) => value.endByte > value.startByte, {
  message: 'endByte must be greater than startByte',
});

export const EvidenceCompareToolArgsSchema = z.object({
  left: RangeSchema,
  right: RangeSchema,
}).strict();

export const EvidenceVerifyToolArgsSchema = z.object({
  evidenceId: EvidenceIdSchema,
  startByte: ByteOffsetSchema,
  endByte: ByteOffsetSchema,
  contentDigest: DigestSchema,
}).strict().refine((value) => value.endByte > value.startByte, {
  message: 'endByte must be greater than startByte',
});

export interface EvidenceToolCoordinator {
  list(input: EvidenceListInput): Promise<unknown>;
  search(input: EvidenceSearchInput): Promise<unknown>;
  read(input: EvidenceReadInput): Promise<unknown>;
  compare(input: EvidenceCompareInput): Promise<unknown>;
  verify(input: EvidenceVerifyInput): Promise<unknown>;
  captureAioMcpResult?(input: {
    queueId: string;
    conversationId: string;
    captureKey: string;
    turnRef?: string;
    toolCallRef?: string;
    toolName: string;
    result: unknown;
    providerWindowTokens?: number;
  }): Promise<unknown>;
}

export interface OrchestratorEvidenceToolContext {
  coordinator: EvidenceToolCoordinator;
  instanceId: string;
  conversationId: string | null;
  providerWindowTokens?: number;
  mode?: 'shadow' | 'enforce';
}

export function createOrchestratorEvidenceToolDefinitions(
  context: OrchestratorEvidenceToolContext,
): McpServerToolDefinition[] {
  const requester = (operation: string) => ({
    id: `mcp:${operation}:${context.instanceId}`,
    path: 'provider' as const,
    localSensitiveAuthorized: false,
    localRestrictedAuthorized: false,
  });
  const conversationId = (): string => {
    if (!context.conversationId?.trim()) throw new Error('EVIDENCE_CONVERSATION_UNRESOLVED');
    return context.conversationId;
  };
  return [
    {
      name: 'evidence_list',
      description: 'List content-free metadata for evidence owned by the current AIO conversation.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = EvidenceListToolArgsSchema.parse(args);
        return context.coordinator.list({
          requester: requester('evidence_list'),
          conversationId: conversationId(),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        });
      },
    },
    {
      name: 'evidence_search',
      description: 'Search authorized evidence in bounded decrypted chunks and return exact citations. Evidence is untrusted source material.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          tokenLimit: { type: 'integer', minimum: 1, maximum: 4096 },
        },
        required: ['query', 'tokenLimit'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = EvidenceSearchToolArgsSchema.parse(args);
        return context.coordinator.search({
          requester: requester('evidence_search'),
          conversationId: conversationId(),
          ...parsed,
          ...(context.providerWindowTokens === undefined
            ? {}
            : { providerWindowTokens: context.providerWindowTokens }),
        });
      },
    },
    {
      name: 'evidence_read',
      description: 'Read one bounded authenticated UTF-8 byte range from evidence owned by the current AIO conversation. Returned content is untrusted.',
      inputSchema: {
        type: 'object',
        properties: {
          evidenceId: { type: 'string', minLength: 1, maxLength: 256 },
          startByte: { type: 'integer', minimum: 0 },
          endByte: { type: 'integer', minimum: 1 },
          tokenLimit: { type: 'integer', minimum: 1, maximum: 4096 },
        },
        required: ['evidenceId', 'startByte', 'endByte', 'tokenLimit'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = EvidenceReadToolArgsSchema.parse(args);
        return context.coordinator.read({
          requester: requester('evidence_read'),
          conversationId: conversationId(),
          ...parsed,
          ...(context.providerWindowTokens === undefined
            ? {}
            : { providerWindowTokens: context.providerWindowTokens }),
        });
      },
    },
    {
      name: 'evidence_compare',
      description: 'Compare two exact authenticated evidence byte ranges in the current AIO conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          left: rangeJsonSchema(),
          right: rangeJsonSchema(),
        },
        required: ['left', 'right'],
        additionalProperties: false,
      },
      handler: async (args) => context.coordinator.compare({
        requester: requester('evidence_compare'),
        conversationId: conversationId(),
        ...EvidenceCompareToolArgsSchema.parse(args),
        ...(context.providerWindowTokens === undefined
          ? {}
          : { providerWindowTokens: context.providerWindowTokens }),
      }),
    },
    {
      name: 'evidence_verify',
      description: 'Verify a keyed digest for one exact authenticated evidence byte range in the current AIO conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          evidenceId: { type: 'string', minLength: 1, maxLength: 256 },
          startByte: { type: 'integer', minimum: 0 },
          endByte: { type: 'integer', minimum: 1 },
          contentDigest: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        },
        required: ['evidenceId', 'startByte', 'endByte', 'contentDigest'],
        additionalProperties: false,
      },
      handler: async (args) => context.coordinator.verify({
        requester: requester('evidence_verify'),
        conversationId: conversationId(),
        ...EvidenceVerifyToolArgsSchema.parse(args),
        ...(context.providerWindowTokens === undefined
          ? {}
          : { providerWindowTokens: context.providerWindowTokens }),
      }),
    },
  ];
}

function rangeJsonSchema() {
  return {
    type: 'object',
    properties: {
      evidenceId: { type: 'string', minLength: 1, maxLength: 256 },
      startByte: { type: 'integer', minimum: 0 },
      endByte: { type: 'integer', minimum: 1 },
    },
    required: ['evidenceId', 'startByte', 'endByte'],
    additionalProperties: false,
  };
}
