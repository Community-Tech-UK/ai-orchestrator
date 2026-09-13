import { z } from 'zod/v4';

export const NODE_EXEC_MAX_TIMEOUT_MS = 120_000;
export const NODE_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const NODE_EXEC_MAX_ARGS = 256;
export const NODE_EXEC_MAX_ARG_LENGTH = 4_096;
export const NODE_EXEC_MAX_ARGV_BYTES = 32 * 1024;
export const NODE_EXEC_MAX_OUTPUT_BYTES = 96 * 1024;
export const NODE_EXEC_SCRIPT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const WorkerNodeExtensionRelaySummarySchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  socketPath: z.string().optional(),
  registration: z.enum(['ok', 'repaired', 'contested', 'error']).optional(),
  lastRegistrationCheckAt: z.number().int().nonnegative().optional(),
  manifestPath: z.string().optional(),
  registrationError: z.string().optional(),
  extensionVersion: z.string().min(1).max(128).optional(),
  extensionReloadedAt: z.number().int().nonnegative().optional(),
  lastExtensionContactAt: z.number().int().nonnegative().optional(),
  forwardsRuntimeEvidence: z.boolean().optional(),
});

export const NodeExecParamsSchema = z.object({
  executable: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(NODE_EXEC_MAX_ARG_LENGTH)).max(NODE_EXEC_MAX_ARGS),
  cwd: z.string().trim().min(1).max(4_096).optional(),
  /** Required by the worker when PowerShell uses -File. Bind to upload_to_node.sha256. */
  scriptSha256: z.string().regex(NODE_EXEC_SCRIPT_SHA256_PATTERN).optional(),
  timeoutMs: z.number().int().min(1).max(NODE_EXEC_MAX_TIMEOUT_MS)
    .optional()
    .default(NODE_EXEC_DEFAULT_TIMEOUT_MS),
}).strict().superRefine((value, context) => {
  const argvBytes = value.args.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0);
  if (argvBytes > NODE_EXEC_MAX_ARGV_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['args'],
      message: `argv exceeds ${NODE_EXEC_MAX_ARGV_BYTES} bytes`,
    });
  }
});

export const NodeExecResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string().refine(
    (value) => Buffer.byteLength(value, 'utf8') <= NODE_EXEC_MAX_OUTPUT_BYTES,
    { message: `stdout exceeds ${NODE_EXEC_MAX_OUTPUT_BYTES} bytes` },
  ),
  stderr: z.string().refine(
    (value) => Buffer.byteLength(value, 'utf8') <= NODE_EXEC_MAX_OUTPUT_BYTES,
    { message: `stderr exceeds ${NODE_EXEC_MAX_OUTPUT_BYTES} bytes` },
  ),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
}).strict();

export type NodeExecParams = z.infer<typeof NodeExecParamsSchema>;
export type NodeExecResult = z.infer<typeof NodeExecResultSchema>;

export const BrowserExtensionRecoverParamsSchema = z.object({}).strict();
export const BrowserExtensionRecoverResultSchema = z.object({
  before: WorkerNodeExtensionRelaySummarySchema,
  after: WorkerNodeExtensionRelaySummarySchema,
}).strict();
export type BrowserExtensionRecoverResult = z.infer<typeof BrowserExtensionRecoverResultSchema>;
