import { z } from 'zod';

const WorkerRequestBaseSchema = z.object({
  id: z.number().int().nonnegative(),
});

const PositionPayloadSchema = z.object({
  filePath: z.string().min(1).max(4000),
  line: z.number().int().min(0),
  character: z.number().int().min(0),
});

export const LspWorkerRequestSchema = z.discriminatedUnion('type', [
  WorkerRequestBaseSchema.extend({
    type: z.literal('ping'),
    payload: z.object({}).default({}),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('shutdown'),
    payload: z.object({}).default({}),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('warm-workspace'),
    payload: z.object({
      workspacePath: z.string().min(1).max(4000),
      language: z.string().min(1).max(50),
    }),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('get-available-servers'),
    payload: z.object({}).default({}),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('get-status'),
    payload: z.object({}).default({}),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('is-available-for-file'),
    payload: z.object({
      filePath: z.string().min(1).max(4000),
    }),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('go-to-definition'),
    payload: PositionPayloadSchema,
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('find-references'),
    payload: PositionPayloadSchema.extend({
      includeDeclaration: z.boolean().optional(),
    }),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('hover'),
    payload: PositionPayloadSchema,
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('document-symbols'),
    payload: z.object({
      filePath: z.string().min(1).max(4000),
    }),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('workspace-symbols'),
    payload: z.object({
      query: z.string().min(1).max(200),
      rootPath: z.string().min(1).max(4000),
    }),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('diagnostics'),
    payload: z.object({
      filePath: z.string().min(1).max(4000),
    }),
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('find-implementations'),
    payload: PositionPayloadSchema,
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('incoming-calls'),
    payload: PositionPayloadSchema,
  }),
  WorkerRequestBaseSchema.extend({
    type: z.literal('outgoing-calls'),
    payload: PositionPayloadSchema,
  }),
]);

export type LspWorkerRequest = z.infer<typeof LspWorkerRequestSchema>;

export const LspWorkerResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type LspWorkerResponse = z.infer<typeof LspWorkerResponseSchema>;
