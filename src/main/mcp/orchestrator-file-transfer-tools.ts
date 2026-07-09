import { z } from 'zod';
import type { McpServerToolDefinition } from './mcp-server-tools';

const NodeTargetSchema = z.string().trim().min(1).max(200);
const RemotePathSchema = z.string().trim().min(1).max(4096);
const LocalPathSchema = z.string().trim().min(1).max(4096);
const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const ExtensionSchema = z.string().trim().min(1).max(32);

export const ListNodeFilesArgsSchema = z.object({
  node: NodeTargetSchema,
  path: RemotePathSchema.optional(),
  depth: z.number().int().min(1).max(3).optional(),
  includeHidden: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().max(500).optional(),
}).strict();

export const FindNodeFilesArgsSchema = z.object({
  node: NodeTargetSchema,
  query: z.string().trim().min(1).max(200).optional(),
  roots: z.array(z.string().trim().min(1).max(100)).max(16).optional(),
  extensions: z.array(ExtensionSchema).max(32).optional(),
  modifiedWithinDays: z.number().int().positive().max(3650).optional(),
  minBytes: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeHash: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.minBytes !== undefined &&
    value.maxBytes !== undefined &&
    value.minBytes > value.maxBytes
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'minBytes must be less than or equal to maxBytes',
      path: ['minBytes'],
    });
  }
});

export const GetNodeFileInfoArgsSchema = z.object({
  node: NodeTargetSchema,
  path: RemotePathSchema,
  hash: z.boolean().optional(),
}).strict();

export const DownloadFromNodeArgsSchema = z.object({
  node: NodeTargetSchema,
  remotePath: RemotePathSchema,
  localPath: LocalPathSchema.optional(),
  expectedSha256: Sha256Schema.optional(),
  overwrite: z.boolean().optional(),
}).strict();

export const UploadToNodeArgsSchema = z.object({
  node: NodeTargetSchema,
  localPath: LocalPathSchema,
  remotePath: RemotePathSchema.optional(),
  expectedSha256: Sha256Schema.optional(),
  overwrite: z.boolean().optional(),
}).strict();

export const CollectBrowserDownloadArgsSchema = z.object({
  node: NodeTargetSchema,
  profileId: z.string().trim().min(1).max(200).optional(),
  browserTargetId: z.string().trim().min(1).max(200).optional(),
  fileNameHint: z.string().trim().min(1).max(200).optional(),
  extensions: z.array(ExtensionSchema).max(32).optional(),
  modifiedWithinMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
  localPath: LocalPathSchema.optional(),
  overwrite: z.boolean().optional(),
}).strict();

export type ListNodeFilesArgs = z.infer<typeof ListNodeFilesArgsSchema>;
export type FindNodeFilesArgs = z.infer<typeof FindNodeFilesArgsSchema>;
export type GetNodeFileInfoArgs = z.infer<typeof GetNodeFileInfoArgsSchema>;
export type DownloadFromNodeArgs = z.infer<typeof DownloadFromNodeArgsSchema>;
export type UploadToNodeArgs = z.infer<typeof UploadToNodeArgsSchema>;
export type CollectBrowserDownloadArgs = z.infer<typeof CollectBrowserDownloadArgsSchema>;

export interface FileTransferToolMeta {
  callerInstanceId?: string | null;
}

export type FileTransferToolFn<TArgs, TResult = unknown> = (
  args: TArgs,
  meta?: FileTransferToolMeta,
) => Promise<TResult>;

export type ListNodeFilesFn = FileTransferToolFn<ListNodeFilesArgs>;
export type FindNodeFilesFn = FileTransferToolFn<FindNodeFilesArgs>;
export type GetNodeFileInfoFn = FileTransferToolFn<GetNodeFileInfoArgs>;
export type DownloadFromNodeFn = FileTransferToolFn<DownloadFromNodeArgs>;
export type UploadToNodeFn = FileTransferToolFn<UploadToNodeArgs>;
export type CollectBrowserDownloadFn = FileTransferToolFn<CollectBrowserDownloadArgs>;

export interface FileTransferToolContext {
  listNodeFiles?: FileTransferToolFn<ListNodeFilesArgs> | null;
  findNodeFiles?: FileTransferToolFn<FindNodeFilesArgs> | null;
  getNodeFileInfo?: FileTransferToolFn<GetNodeFileInfoArgs> | null;
  downloadFromNode?: FileTransferToolFn<DownloadFromNodeArgs> | null;
  uploadToNode?: FileTransferToolFn<UploadToNodeArgs> | null;
  collectBrowserDownload?: FileTransferToolFn<CollectBrowserDownloadArgs> | null;
  instanceId?: string | null;
}

export function createFileTransferToolDefinitions(
  context: FileTransferToolContext,
): McpServerToolDefinition[] {
  return [
    {
      name: 'list_node_files',
      description:
        'List allowlisted transfer roots or browse files on a connected worker node. Use this before downloading when you need to inspect remote browserDownloads, Downloads, Documents, Desktop, scratch, or project folders.',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Worker node name or id.' },
          path: { type: 'string', description: 'Remote folder path. Omit to list configured transfer roots.' },
          depth: { type: 'integer', minimum: 1, maximum: 3 },
          includeHidden: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          cursor: { type: 'string' },
        },
        required: ['node'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = ListNodeFilesArgsSchema.parse(args);
        return requireTransferFn(context.listNodeFiles, 'list_node_files')(parsed, meta(context));
      },
    },
    {
      name: 'find_node_files',
      description:
        'Find likely files in a worker node transfer root by name, extension, size, and modification age without browsing entire folders manually.',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Worker node name or id.' },
          query: { type: 'string', description: 'Text to match against basename/path.' },
          roots: { type: 'array', items: { type: 'string' }, description: 'Root ids such as browserDownloads, downloads, documents, desktop, or scratch.' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'Extensions such as .docx, .pdf, .xlsx, .zip, .png.' },
          modifiedWithinDays: { type: 'integer', minimum: 1, maximum: 3650 },
          minBytes: { type: 'integer', minimum: 0 },
          maxBytes: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          includeHash: { type: 'boolean' },
        },
        required: ['node'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = FindNodeFilesArgsSchema.parse(args);
        return requireTransferFn(context.findNodeFiles, 'find_node_files')(parsed, meta(context));
      },
    },
    {
      name: 'get_node_file_info',
      description:
        'Get metadata and optional SHA-256 for one file on a worker node before transferring it.',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Worker node name or id.' },
          path: { type: 'string', description: 'Remote file path.' },
          hash: { type: 'boolean', description: 'Compute SHA-256. Defaults to true.' },
        },
        required: ['node', 'path'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = GetNodeFileInfoArgsSchema.parse(args);
        return requireTransferFn(context.getNodeFileInfo, 'get_node_file_info')(parsed, meta(context));
      },
    },
    {
      name: 'download_from_node',
      description:
        'Copy one file from a connected worker node into the local workspace over the existing worker connection. Returns size and SHA-256.',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Worker node name or id.' },
          remotePath: { type: 'string', description: 'Remote file path inside an allowlisted transfer root or worker project directory.' },
          localPath: { type: 'string', description: 'Destination path inside the local workspace. Omit to use _scratch/aio-transfers/.' },
          expectedSha256: { type: 'string', description: 'Optional expected SHA-256 hex digest.' },
          overwrite: { type: 'boolean', description: 'Overwrite an existing local destination. Defaults to false.' },
        },
        required: ['node', 'remotePath'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = DownloadFromNodeArgsSchema.parse(args);
        return requireTransferFn(context.downloadFromNode, 'download_from_node')(parsed, meta(context));
      },
    },
    {
      name: 'upload_to_node',
      description:
        'Copy one local workspace file to a connected worker node. If remotePath is omitted, the file is staged into the node scratch transfer folder.',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Worker node name or id.' },
          localPath: { type: 'string', description: 'Local workspace file path.' },
          remotePath: { type: 'string', description: 'Optional remote destination path.' },
          expectedSha256: { type: 'string', description: 'Optional expected SHA-256 hex digest for the local file.' },
          overwrite: { type: 'boolean', description: 'Overwrite an existing remote destination. Defaults to false.' },
        },
        required: ['node', 'localPath'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = UploadToNodeArgsSchema.parse(args);
        return requireTransferFn(context.uploadToNode, 'upload_to_node')(parsed, meta(context));
      },
    },
    {
      name: 'collect_browser_download',
      description:
        'Find a recent browser download on a worker node and download it locally when exactly one strong candidate matches. Returns candidates when ambiguous.',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Worker node name or id.' },
          profileId: { type: 'string' },
          browserTargetId: { type: 'string' },
          fileNameHint: { type: 'string', description: 'Filename text to match.' },
          extensions: { type: 'array', items: { type: 'string' } },
          modifiedWithinMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          localPath: { type: 'string', description: 'Optional local destination path.' },
          overwrite: { type: 'boolean' },
        },
        required: ['node'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = CollectBrowserDownloadArgsSchema.parse(args);
        return requireTransferFn(context.collectBrowserDownload, 'collect_browser_download')(
          parsed,
          meta(context),
        );
      },
    },
  ];
}

function requireTransferFn<TArgs>(
  fn: FileTransferToolFn<TArgs> | null | undefined,
  toolName: string,
): FileTransferToolFn<TArgs> {
  if (!fn) {
    throw new Error(`${toolName} is unavailable: worker node file transfer is not wired in this process`);
  }
  return fn;
}

function meta(context: FileTransferToolContext): FileTransferToolMeta {
  return { callerInstanceId: context.instanceId ?? null };
}
