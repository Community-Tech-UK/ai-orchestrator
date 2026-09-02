import { z } from 'zod';
import type {
  IndexingError,
  IndexStats,
} from '../../shared/types/codebase.types';

export const MAX_INDEXING_LANE_BATCH_FILES = 256;

const boundedPathSchema = z.string().min(1).max(4_096);
const boundedStoreIdSchema = z.string().min(1).max(512);
const optionalUserDataPathSchema = boundedPathSchema.optional();
const uniqueSyncPathArraySchema = z.array(boundedPathSchema)
  .max(MAX_INDEXING_LANE_BATCH_FILES)
  .superRefine((paths, context) => {
    const seen = new Set<string>();
    for (const [index, filePath] of paths.entries()) {
      if (seen.has(filePath)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate sync-files path',
          path: [index],
        });
      }
      seen.add(filePath);
    }
  });

const indexCodebaseJobSchema = z.object({
  type: z.literal('index-codebase'),
  rootPath: boundedPathSchema,
  storeId: boundedStoreIdSchema.optional(),
  force: z.boolean().optional(),
  userDataPath: optionalUserDataPathSchema,
}).strict();

const indexFileJobSchema = z.object({
  type: z.literal('index-file'),
  storeId: boundedStoreIdSchema,
  filePath: boundedPathSchema,
  userDataPath: optionalUserDataPathSchema,
}).strict();

const removeFileJobSchema = z.object({
  type: z.literal('remove-file'),
  storeId: boundedStoreIdSchema,
  filePath: boundedPathSchema,
  userDataPath: optionalUserDataPathSchema,
}).strict();

const getStatsJobSchema = z.object({
  type: z.literal('get-stats'),
  storeId: boundedStoreIdSchema,
  userDataPath: optionalUserDataPathSchema,
}).strict();

const clearLegacyStoreJobSchema = z.object({
  type: z.literal('clear-legacy-store'),
  storeId: boundedStoreIdSchema,
  userDataPath: optionalUserDataPathSchema,
}).strict();

const syncFilesJobSchema = z.object({
  type: z.literal('sync-files'),
  storeId: boundedStoreIdSchema,
  deletions: uniqueSyncPathArraySchema,
  upserts: uniqueSyncPathArraySchema,
  userDataPath: optionalUserDataPathSchema,
}).strict().superRefine((job, context) => {
  const deletions = new Set(job.deletions);
  for (const [index, filePath] of job.upserts.entries()) {
    if (deletions.has(filePath)) {
      context.addIssue({
        code: 'custom',
        message: 'Overlapping sync-files path',
        path: ['upserts', index],
      });
    }
  }
});

export const codebaseIndexingLaneJobSchema = z.discriminatedUnion('type', [
  indexCodebaseJobSchema,
  indexFileJobSchema,
  removeFileJobSchema,
  getStatsJobSchema,
  clearLegacyStoreJobSchema,
  syncFilesJobSchema,
]);

export type CodebaseIndexingLaneJob = z.infer<typeof codebaseIndexingLaneJobSchema>;
export type CodebaseIndexingLaneJobType = CodebaseIndexingLaneJob['type'];

export interface CodebaseIndexingLaneResult {
  rootPath: string;
  filesIndexed: number;
  chunksCreated: number;
  tokensProcessed: number;
  duration: number;
  errors: IndexingError[];
  completedAt: number;
}

export type CodebaseIndexingFileOperation = 'indexed' | 'removed';

export interface CodebaseIndexingFileOutcome {
  operation: CodebaseIndexingFileOperation;
  filePath: string;
  success: boolean;
  error?: string;
}

export interface CodebaseIndexingSyncFilesResult {
  outcomes: CodebaseIndexingFileOutcome[];
}

export type CodebaseIndexingStatsResult = IndexStats;

export function parseCodebaseIndexingLaneJob(payload: unknown): CodebaseIndexingLaneJob {
  if (isOversizedSyncBatch(payload)) {
    throw new Error(
      `Indexing lane sync-files accepts at most ${MAX_INDEXING_LANE_BATCH_FILES} file paths`,
    );
  }
  const parsed = codebaseIndexingLaneJobSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid indexing lane payload: ${parsed.error.message}`);
  }
  return parsed.data;
}

function isOversizedSyncBatch(payload: unknown): boolean {
  if (
    typeof payload !== 'object'
    || payload === null
    || (payload as { type?: unknown }).type !== 'sync-files'
  ) {
    return false;
  }
  const candidate = payload as { deletions?: unknown; upserts?: unknown };
  const deletions = Array.isArray(candidate.deletions) ? candidate.deletions.length : 0;
  const upserts = Array.isArray(candidate.upserts) ? candidate.upserts.length : 0;
  return deletions + upserts > MAX_INDEXING_LANE_BATCH_FILES;
}
