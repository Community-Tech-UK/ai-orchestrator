/**
 * Wire contract for running a Plan Queue job on another computer (spec:
 * docs/specs/2026-11-08-plan-queue-jobs-on-other-computers_spec_planned.md).
 *
 * Both sides import this file: the worker (src/worker-agent/queue-jobs/) answers the calls, and this Mac
 * (src/main/plan-queue/remote/) makes them. Every call needs the worker's `queueJobs: 1` capability and the
 * service scope. Names that become folders or git references are checked here, once, so neither side builds a
 * path from an unchecked string.
 */
import { z } from 'zod/v4';

/** The `queueJobs` capability value whose wire shape this file describes. */
export const QUEUE_JOBS_PROTOCOL = 1;

/** The most bytes of git pack one call carries before base64 (so a call stays far below the socket's frame limit). */
export const QUEUE_PACK_CHUNK_BYTES = 512 * 1024;
const MAX_CHUNK_BASE64 = Math.ceil(QUEUE_PACK_CHUNK_BYTES / 3) * 4 + 8;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** A project's name on the computer: a folder name under `queue-repos`. */
export const QueueProjectSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
/** The job's id (the queue item's id). */
export const QueueJobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
/** The job's branch, always under `queue/`, with no `..` and no leading slash. */
export const QueueBranchSchema = z.string().regex(/^queue\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/).max(200)
  .refine(branch => !branch.includes('..') && !branch.endsWith('.lock'));
export const QueueShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
/** One worker turn's id; names the report file. */
export const QueueTurnIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
/** A path inside a repository or planning folder: relative, forward slashes, nothing that climbs out. */
export const QueueRelativePathSchema = z.string().min(1).max(500)
  .refine(file => !file.startsWith('/') && !/^[A-Za-z]:/.test(file) && !file.includes('\\') && !file.includes('\0')
    && !file.split('/').some(part => part === '..' || part === '' || part === '.'));

/** A planning document, sent or returned whole. */
export const QueueDocumentSchema = z.object({
  path: QueueRelativePathSchema,
  contentBase64: z.string().max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 8),
}).strict();
export type QueueDocument = z.infer<typeof QueueDocumentSchema>;

export const QueueHaveParamsSchema = z.object({
  project: QueueProjectSchema,
  candidates: z.array(QueueShaSchema).max(2000),
}).strict();
export const QueueHaveResultSchema = z.object({ have: z.array(QueueShaSchema) }).strict();

/**
 * One chunk of a thin pack. The last chunk (`index === total - 1`) carries `final`: the worker then unpacks the
 * assembled pack into the project's bare repository and records the job's three references. An empty pack
 * (`total: 1`, `dataBase64: ''`) records the references when the commit is already there.
 */
export const QueueReceiveParamsSchema = z.object({
  project: QueueProjectSchema,
  jobId: QueueJobIdSchema,
  uploadId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  index: z.number().int().min(0).max(100_000),
  total: z.number().int().min(1).max(100_001),
  dataBase64: z.string().max(MAX_CHUNK_BASE64),
  final: z.object({
    /** The commit now being sent: the job's folder moves to it on `queue.prepare`. */
    commit: QueueShaSchema,
    /** The base branch's tip, for the agent's own comparisons; null when the job has none. */
    baseTip: QueueShaSchema.nullable(),
    /** The commit the job started from. */
    startCommit: QueueShaSchema,
  }).strict().optional(),
}).strict().refine(params => params.index < params.total && (params.index < params.total - 1 || params.final !== undefined));
export const QueueReceiveResultSchema = z.object({ complete: z.boolean() }).strict();

export const QueuePrepareParamsSchema = z.object({
  project: QueueProjectSchema,
  jobId: QueueJobIdSchema,
  branch: QueueBranchSchema,
  /** The commit the job's folder must be at: the last one received for this job. */
  commit: QueueShaSchema,
  /** Planning documents this Mac last sent or copied back; they are written into the planning folder as sent. */
  documents: z.array(QueueDocumentSchema).max(200),
  /** The worker turn that is about to start; its report file is named from it. */
  turnId: QueueTurnIdSchema,
}).strict();
export const QueuePrepareResultSchema = z.object({
  /** Where the agent works: pass as the session's folder. */
  jobFolder: z.string().min(1),
  /** Planning documents live here at their repository paths. Extra folder for the session. */
  planningFolder: z.string().min(1),
  /** This turn's report goes in `reportFile` inside this folder. Extra folder for the session. */
  reportFolder: z.string().min(1),
  reportFile: z.string().min(1),
  /** Untracked paths the folder's setup left (never collected). */
  provisioned: z.array(z.string()),
  /** True when this call installed the project's dependencies again because the lock file differs. */
  installed: z.boolean(),
}).strict();

export const QueueRefusalReasonSchema = z.enum([
  'session-running', 'wrong-parent', 'agent-committed', 'path-outside', 'no-copy', 'not-prepared',
]);
export type QueueRefusalReason = z.infer<typeof QueueRefusalReasonSchema>;

export const QueueCollectParamsSchema = z.object({
  project: QueueProjectSchema,
  jobId: QueueJobIdSchema,
  branch: QueueBranchSchema,
  /** The last commit this Mac sent for the job: the collected commit's parent, and the thin pack's base. */
  expectedParent: QueueShaSchema,
}).strict();
export const QueueCollectResultSchema = z.union([
  z.object({ refused: z.object({ reason: QueueRefusalReasonSchema, message: z.string().max(2000) }).strict() }).strict(),
  z.object({
    /** A commit on a side reference (never the job's branch) holding everything the agent changed. */
    commit: QueueShaSchema,
    /** Fetch the pack with `queue.fetchPack` for `index` 0 to `packChunks - 1`. Zero chunks: nothing to fetch. */
    packId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    packChunks: z.number().int().min(0).max(100_000),
    /** Planning-folder files changed since last sent, whole; `deleted` are paths that were sent and are gone. */
    documents: z.array(QueueDocumentSchema).max(500),
    deleted: z.array(QueueRelativePathSchema).max(500),
  }).strict(),
]);

export const QueueFetchPackParamsSchema = z.object({
  packId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  index: z.number().int().min(0).max(100_000),
}).strict();
export const QueueFetchPackResultSchema = z.object({ dataBase64: z.string().max(MAX_CHUNK_BASE64) }).strict();

export const QueueReadReportParamsSchema = z.object({
  jobId: QueueJobIdSchema,
  turnId: QueueTurnIdSchema,
}).strict();
/** The named turn's file only; `text` is null when it is absent. Other turns' files are deleted by this call. */
export const QueueReadReportResultSchema = z.object({ text: z.string().max(1024 * 1024).nullable() }).strict();

export const QueueDeleteLeftOutParamsSchema = z.object({
  project: QueueProjectSchema,
  jobId: QueueJobIdSchema,
  branch: QueueBranchSchema,
  /** Paths in the job's folder that this Mac's save left out of the commit (planning files it moved, and so on). */
  files: z.array(QueueRelativePathSchema).max(2000),
}).strict();
export const QueueDeleteLeftOutResultSchema = z.object({
  deleted: z.array(QueueRelativePathSchema),
  /** Named files that were refused (outside the folder, tracked by git, or a folder) and left alone. */
  skipped: z.array(z.string()),
}).strict();

export const QueueRemoveParamsSchema = z.object({
  project: QueueProjectSchema,
  jobId: QueueJobIdSchema,
  branch: QueueBranchSchema,
}).strict();
export const QueueRemoveResultSchema = z.object({ removed: z.boolean() }).strict();

/** `scripts` are package.json script names run as `npm run <name>`; the install is done by the worker itself. */
export const QueueProjectCheckParamsSchema = z.object({
  project: QueueProjectSchema,
  /** A commit already received under the job id `jobId`. */
  jobId: QueueJobIdSchema,
  scripts: z.array(z.string().regex(/^[a-z][a-z0-9:_-]{0,60}$/)).max(8),
}).strict();
export const QueueProjectCheckResultSchema = z.object({
  ok: z.boolean(),
  steps: z.array(z.object({
    name: z.string().max(100), ms: z.number().nonnegative(), ok: z.boolean(), tail: z.string().max(4000),
  }).strict()).max(20),
  /** How long it took to give a fresh job folder its dependencies from the installed checkout. */
  copyMs: z.number().nonnegative().nullable(),
  /** Why it failed, in words, when `ok` is false. */
  problem: z.string().max(2000).nullable(),
}).strict();

export type QueueHaveParams = z.infer<typeof QueueHaveParamsSchema>;
export type QueueHaveResult = z.infer<typeof QueueHaveResultSchema>;
export type QueueReceiveParams = z.infer<typeof QueueReceiveParamsSchema>;
export type QueueReceiveResult = z.infer<typeof QueueReceiveResultSchema>;
export type QueuePrepareParams = z.infer<typeof QueuePrepareParamsSchema>;
export type QueuePrepareResult = z.infer<typeof QueuePrepareResultSchema>;
export type QueueCollectParams = z.infer<typeof QueueCollectParamsSchema>;
export type QueueCollectResult = z.infer<typeof QueueCollectResultSchema>;
export type QueueFetchPackParams = z.infer<typeof QueueFetchPackParamsSchema>;
export type QueueFetchPackResult = z.infer<typeof QueueFetchPackResultSchema>;
export type QueueReadReportParams = z.infer<typeof QueueReadReportParamsSchema>;
export type QueueReadReportResult = z.infer<typeof QueueReadReportResultSchema>;
export type QueueDeleteLeftOutParams = z.infer<typeof QueueDeleteLeftOutParamsSchema>;
export type QueueDeleteLeftOutResult = z.infer<typeof QueueDeleteLeftOutResultSchema>;
export type QueueRemoveParams = z.infer<typeof QueueRemoveParamsSchema>;
export type QueueRemoveResult = z.infer<typeof QueueRemoveResultSchema>;
export type QueueProjectCheckParams = z.infer<typeof QueueProjectCheckParamsSchema>;
export type QueueProjectCheckResult = z.infer<typeof QueueProjectCheckResultSchema>;

/**
 * What the worker side implements (src/worker-agent/queue-jobs/queue-job-host.ts), one method per call. The
 * dispatcher parses each call's params with the schemas above and hands them straight in.
 */
export interface QueueJobHostApi {
  have(params: QueueHaveParams): Promise<QueueHaveResult>;
  receive(params: QueueReceiveParams): Promise<QueueReceiveResult>;
  prepare(params: QueuePrepareParams): Promise<QueuePrepareResult>;
  collect(params: QueueCollectParams): Promise<QueueCollectResult>;
  fetchPack(params: QueueFetchPackParams): Promise<QueueFetchPackResult>;
  readReport(params: QueueReadReportParams): Promise<QueueReadReportResult>;
  deleteLeftOut(params: QueueDeleteLeftOutParams): Promise<QueueDeleteLeftOutResult>;
  remove(params: QueueRemoveParams): Promise<QueueRemoveResult>;
  projectCheck(params: QueueProjectCheckParams): Promise<QueueProjectCheckResult>;
}

/** The project's name on a computer, from the repository's path on this Mac: readable and stable. */
export function queueProjectKey(repoRoot: string, hash: (value: string) => string): string {
  const base = repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'project';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'project';
  return `${safe}-${hash(repoRoot).slice(0, 8)}`;
}
