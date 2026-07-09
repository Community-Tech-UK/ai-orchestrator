import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogger } from '../logging/logger';
import { SecurityFilter } from './security-filter';
import { getFileTransferService } from './file-transfer-service';
import { NodeFileTransferMcpError } from './remote-node-file-transfer-mcp-errors';
import {
  assertClosestExistingPathInsideWorkspace,
  assertExistingPathInsideWorkspace,
  exists,
  isWindowsStylePath,
  lstatOrNull,
  normalizeExtension,
  resolveInsideWorkspace,
  sanitizeBasename,
  sha256,
} from './remote-node-file-transfer-path-utils';
import { getWorkerNodeConnectionServer } from './worker-node-connection';
import {
  getWorkerNodeRegistry,
  resolveWorkerNodeTarget,
} from './worker-node-registry';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import type {
  CollectBrowserDownloadArgs,
  DownloadFromNodeArgs,
  FileTransferToolMeta,
  FindNodeFilesFn,
  FindNodeFilesArgs,
  GetNodeFileInfoArgs,
  GetNodeFileInfoFn,
  ListNodeFilesArgs,
  ListNodeFilesFn,
  UploadToNodeArgs,
  UploadToNodeFn,
  DownloadFromNodeFn,
  CollectBrowserDownloadFn,
} from '../mcp/orchestrator-file-transfer-tools';
import type {
  FsEntry,
  FsReadDirectoryResult,
  FsReadFileResult,
  FsStatResult,
} from '../../shared/types/remote-fs.types';
import type {
  WorkerNodeFileTransferRoot,
  WorkerNodeFileTransferSummary,
  WorkerNodeInfo,
} from '../../shared/types/worker-node.types';

const logger = getLogger('RemoteNodeFileTransferMcpService');
const DEFAULT_FIND_LIMIT = 20;
const DEFAULT_DOWNLOAD_MINUTES = 30;
const FIND_DIRECTORY_ENTRY_LIMIT = 1000;
const BROWSER_DOWNLOADS_ROOT_ID = 'browserDownloads';
const COLLECT_BROWSER_DOWNLOAD_ROOT_IDS = [BROWSER_DOWNLOADS_ROOT_ID, 'downloads'];

export { NodeFileTransferMcpError } from './remote-node-file-transfer-mcp-errors';

type SafetyClassification =
  | 'normal'
  | 'restricted'
  | 'sensitiveName'
  | 'outsideRoots'
  | 'tooLarge';

export interface RemoteNodeFileTransferImplementationsOptions {
  resolveLocalWorkspace?: (callerInstanceId: string | null | undefined) => string | undefined;
}

interface ResolvedNode {
  node: WorkerNodeInfo;
  fileTransfer: WorkerNodeFileTransferSummary;
}

interface RemoteCandidate {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  extension?: string;
  rootId: string;
  rootLabel: string;
  approvalRequired?: boolean;
  sha256?: string;
}

export function createRemoteNodeFileTransferImplementations(
  options: RemoteNodeFileTransferImplementationsOptions = {},
): {
  listNodeFiles: ListNodeFilesFn;
  findNodeFiles: FindNodeFilesFn;
  getNodeFileInfo: GetNodeFileInfoFn;
  downloadFromNode: DownloadFromNodeFn;
  uploadToNode: UploadToNodeFn;
  collectBrowserDownload: CollectBrowserDownloadFn;
} {
  const service = new RemoteNodeFileTransferMcpService(options);
  return {
    listNodeFiles: (args, meta) => service.listNodeFiles(args, meta),
    findNodeFiles: (args, meta) => service.findNodeFiles(args, meta),
    getNodeFileInfo: (args, meta) => service.getNodeFileInfo(args, meta),
    downloadFromNode: (args, meta) => service.downloadFromNode(args, meta),
    uploadToNode: (args, meta) => service.uploadToNode(args, meta),
    collectBrowserDownload: (args, meta) => service.collectBrowserDownload(args, meta),
  };
}

class RemoteNodeFileTransferMcpService {
  constructor(private readonly options: RemoteNodeFileTransferImplementationsOptions) {}

  async listNodeFiles(args: ListNodeFilesArgs, meta: FileTransferToolMeta = {}): Promise<unknown> {
    const resolved = this.resolveNode(args.node);
    if (!args.path) {
      return {
        nodeId: resolved.node.id,
        nodeName: resolved.node.name,
        roots: resolved.fileTransfer.roots.map(publicRoot),
        entries: resolved.fileTransfer.roots.map((root) => rootEntry(root)),
        truncated: false,
      };
    }
    this.requireRemoteRead(resolved, args.path);
    const result = await this.sendRpc<FsReadDirectoryResult>(
      resolved.node.id,
      COORDINATOR_TO_NODE.FS_READ_DIRECTORY,
      {
        path: args.path,
        depth: args.depth ?? 1,
        includeHidden: args.includeHidden ?? false,
        limit: args.limit ?? 500,
        cursor: args.cursor,
      },
    );
    audit('list_node_files', 'allowed', resolved.node, {
      callerInstanceId: meta.callerInstanceId,
      sourcePath: args.path,
      size: result.entries.length,
    });
    return {
      nodeId: resolved.node.id,
      nodeName: resolved.node.name,
      entries: result.entries.map((entry) => this.decorateEntry(resolved, entry)),
      cursor: result.cursor,
      truncated: result.truncated,
    };
  }

  async findNodeFiles(args: FindNodeFilesArgs, meta: FileTransferToolMeta = {}): Promise<unknown> {
    const resolved = this.resolveNode(args.node);
    const roots = this.selectReadableTransferRoots(resolved.fileTransfer, args.roots);
    const limit = args.limit ?? DEFAULT_FIND_LIMIT;
    const candidates: RemoteCandidate[] = [];
    for (const root of roots) {
      const tree = await this.sendRpc<FsReadDirectoryResult>(
        resolved.node.id,
        COORDINATOR_TO_NODE.FS_READ_DIRECTORY,
        { path: root.path, depth: 3, includeHidden: false, limit: FIND_DIRECTORY_ENTRY_LIMIT },
      );
      candidates.push(
        ...flattenEntries(tree.entries)
          .filter((entry) => !entry.isDirectory)
          .map((entry) => this.toCandidate(entry, root))
          .filter((candidate) => matchesFind(candidate, args)),
      );
    }
    const ordered = candidates
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, limit);
    if (args.includeHash) {
      for (const candidate of ordered) {
        if (
          !candidate.approvalRequired &&
          !SecurityFilter.isRestrictedPath(candidate.path) &&
          candidate.size <= resolved.fileTransfer.maxFileBytes
        ) {
          candidate.sha256 = await this.hashRemoteFile(resolved.node.id, candidate.path);
        }
      }
    }
    audit('find_node_files', 'allowed', resolved.node, {
      callerInstanceId: meta.callerInstanceId,
      size: ordered.length,
    });
    return {
      nodeId: resolved.node.id,
      nodeName: resolved.node.name,
      candidates: ordered,
    };
  }

  async getNodeFileInfo(args: GetNodeFileInfoArgs, meta: FileTransferToolMeta = {}): Promise<unknown> {
    const resolved = this.resolveNode(args.node);
    const root = this.findReadableRoot(resolved, args.path);
    const stat = root
      ? await this.sendRpc<FsStatResult>(resolved.node.id, COORDINATOR_TO_NODE.FS_STAT, { path: args.path })
      : null;
    const classification = this.classifyPath(resolved, args.path, stat);
    const response: Record<string, unknown> = {
      nodeId: resolved.node.id,
      nodeName: resolved.node.name,
      path: args.path,
      exists: stat?.exists ?? false,
      size: stat?.size ?? 0,
      modifiedAt: stat?.modifiedAt ?? 0,
      isDirectory: stat?.isDirectory ?? false,
      rootId: root?.id,
      rootLabel: root?.label,
      safetyClassification: classification,
    };
    if ((args.hash ?? true) && classification === 'normal' && stat?.exists && !stat.isDirectory) {
      const read = await this.readRemoteFile(resolved.node.id, args.path);
      response['sha256'] = sha256(Buffer.from(read.data, 'base64'));
      response['mimeType'] = read.mimeType;
    }
    audit('get_node_file_info', classification === 'normal' ? 'allowed' : 'refused', resolved.node, {
      callerInstanceId: meta.callerInstanceId,
      sourcePath: args.path,
      size: stat?.size ?? 0,
      refusalReason: classification === 'normal' ? undefined : classification,
    });
    return response;
  }

  async downloadFromNode(args: DownloadFromNodeArgs, meta: FileTransferToolMeta = {}): Promise<unknown> {
    const resolved = this.resolveNode(args.node);
    this.requireRemoteRead(resolved, args.remotePath);
    const stat = await this.sendRpc<FsStatResult>(
      resolved.node.id,
      COORDINATOR_TO_NODE.FS_STAT,
      { path: args.remotePath },
    );
    if (!stat.exists) {
      throw new NodeFileTransferMcpError('file_not_found', `Remote file does not exist: ${args.remotePath}`);
    }
    if (stat.isDirectory) {
      throw new NodeFileTransferMcpError('not_a_file', `Remote path is a directory: ${args.remotePath}`);
    }
    if (stat.size > resolved.fileTransfer.maxFileBytes) {
      throw new NodeFileTransferMcpError(
        'file_too_large_for_v1_transfer',
        `File is ${stat.size} bytes`,
        'streaming transfer required for files over 50 MB',
      );
    }
    const localPath = await this.resolveLocalDestination(args.localPath, args.remotePath, meta);
    if (args.overwrite !== true && await exists(localPath)) {
      throw new NodeFileTransferMcpError('destination_exists', `Local destination exists: ${localPath}`);
    }
    const result = await getFileTransferService().copyFromRemote({
      nodeId: resolved.node.id,
      remotePath: args.remotePath,
      localPath,
      expectedSha256: args.expectedSha256,
      overwrite: args.overwrite === true,
    });
    audit('download_from_node', 'allowed', resolved.node, {
      callerInstanceId: meta.callerInstanceId,
      sourcePath: args.remotePath,
      destinationPath: result.to,
      size: result.size,
      sha256: result.sha256,
    });
    return {
      ok: true,
      nodeId: resolved.node.id,
      nodeName: resolved.node.name,
      remotePath: args.remotePath,
      localPath: result.to,
      size: result.size,
      sha256: result.sha256,
      mimeType: result.mimeType,
    };
  }

  async uploadToNode(args: UploadToNodeArgs, meta: FileTransferToolMeta = {}): Promise<unknown> {
    const resolved = this.resolveNode(args.node);
    const localPath = await this.resolveLocalSource(args.localPath, meta);
    const buffer = await fs.readFile(localPath);
    const digest = sha256(buffer);
    if (args.expectedSha256 && digest !== args.expectedSha256.toLowerCase()) {
      throw new NodeFileTransferMcpError('integrity_mismatch', 'Local source hash did not match expectedSha256');
    }
    if (buffer.length > resolved.fileTransfer.maxFileBytes) {
      throw new NodeFileTransferMcpError(
        'file_too_large_for_v1_transfer',
        `File is ${buffer.length} bytes`,
        'streaming transfer required for files over 50 MB',
      );
    }
    const remotePath = args.remotePath ?? this.defaultRemoteScratchPath(resolved, localPath);
    this.requireRemoteWrite(resolved, remotePath);
    if (args.overwrite !== true) {
      const stat = await this.sendRpc<FsStatResult>(
        resolved.node.id,
        COORDINATOR_TO_NODE.FS_STAT,
        { path: remotePath },
      );
      if (stat.exists) {
        throw new NodeFileTransferMcpError('destination_exists', `Remote destination exists: ${remotePath}`);
      }
    }
    const result = await getFileTransferService().copyToRemote({
      nodeId: resolved.node.id,
      localPath,
      remotePath,
      expectedSha256: args.expectedSha256,
      overwrite: args.overwrite === true,
    });
    audit('upload_to_node', 'allowed', resolved.node, {
      callerInstanceId: meta.callerInstanceId,
      sourcePath: localPath,
      destinationPath: remotePath,
      size: result.size,
      sha256: result.sha256,
    });
    return {
      ok: true,
      nodeId: resolved.node.id,
      nodeName: resolved.node.name,
      localPath,
      remotePath,
      size: result.size,
      sha256: result.sha256,
    };
  }

  async collectBrowserDownload(args: CollectBrowserDownloadArgs, meta: FileTransferToolMeta = {}): Promise<unknown> {
    const resolved = this.resolveNode(args.node);
    const roots = this.collectBrowserDownloadRootIds(resolved.fileTransfer);
    const findResult = await this.findNodeFiles({
      node: args.node,
      query: args.fileNameHint,
      roots,
      extensions: args.extensions,
      modifiedWithinDays: Math.ceil((args.modifiedWithinMinutes ?? DEFAULT_DOWNLOAD_MINUTES) / (24 * 60)),
      limit: roots.length * FIND_DIRECTORY_ENTRY_LIMIT,
    }, meta) as { nodeId?: string; nodeName?: string; candidates: RemoteCandidate[] };
    const cutoff = Date.now() - (args.modifiedWithinMinutes ?? DEFAULT_DOWNLOAD_MINUTES) * 60_000;
    const recentCandidates = findResult.candidates.filter((candidate) => candidate.modifiedAt >= cutoff);
    const candidates = this.firstPreferredRootCandidates(recentCandidates, roots);
    if (candidates.length === 0) {
      return {
        ok: false,
        code: 'no_download_candidates',
        nodeId: findResult.nodeId,
        nodeName: findResult.nodeName,
        profileId: args.profileId,
        browserTargetId: args.browserTargetId,
        candidates: [],
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        code: 'multiple_download_candidates',
        nodeId: findResult.nodeId,
        nodeName: findResult.nodeName,
        profileId: args.profileId,
        browserTargetId: args.browserTargetId,
        candidates,
      };
    }
    const candidate = candidates[0];
    if (!candidate) {
      return {
        ok: false,
        code: 'no_download_candidates',
        nodeId: findResult.nodeId,
        nodeName: findResult.nodeName,
        profileId: args.profileId,
        browserTargetId: args.browserTargetId,
        candidates: [],
      };
    }
    const transfer = await this.downloadFromNode({
      node: args.node,
      remotePath: candidate.path,
      localPath: args.localPath ?? path.join('_scratch', 'aio-transfers', sanitizeBasename(candidate.path)),
      overwrite: args.overwrite === true,
    }, meta);
    return {
      ...(transfer as Record<string, unknown>),
      profileId: args.profileId,
      browserTargetId: args.browserTargetId,
      candidate,
    };
  }

  private resolveNode(nodeSelector: string): ResolvedNode {
    const registry = getWorkerNodeRegistry();
    const server = getWorkerNodeConnectionServer();
    const connected = registry.getAllNodes().filter((node) => server.isNodeConnected(node.id));
    const resolved = resolveWorkerNodeTarget(nodeSelector, connected);
    if ('error' in resolved) {
      throw new NodeFileTransferMcpError('node_not_found', resolved.error);
    }
    const node = registry.getNode(resolved.nodeId);
    if (!node || !server.isNodeConnected(node.id)) {
      throw new NodeFileTransferMcpError('node_disconnected', `Node is not connected: ${nodeSelector}`);
    }
    const fileTransfer = node.capabilities.fileTransfer;
    if (!fileTransfer?.enabled) {
      throw new NodeFileTransferMcpError('file_transfer_disabled', `File transfer is disabled on ${node.name}`);
    }
    return { node, fileTransfer };
  }

  private requireRemoteRead(resolved: ResolvedNode, remotePath: string): void {
    const root = this.findReadableRoot(resolved, remotePath);
    const classification = this.classifyPath(resolved, remotePath, null);
    if (!root || classification !== 'normal') {
      throw new NodeFileTransferMcpError(
        classification === 'outsideRoots' ? 'path_outside_allowed_roots' : 'restricted_file',
        `Remote read refused for ${remotePath}`,
      );
    }
  }

  private requireRemoteWrite(resolved: ResolvedNode, remotePath: string): void {
    if (!this.findWritableRoot(resolved, remotePath)) {
      throw new NodeFileTransferMcpError('remote_write_refused', `Remote write refused for ${remotePath}`);
    }
    if (SecurityFilter.isRestrictedPath(remotePath)) {
      throw new NodeFileTransferMcpError('restricted_file', `Remote write refused for restricted path ${remotePath}`);
    }
  }

  private findReadableRoot(resolved: ResolvedNode, remotePath: string): WorkerNodeFileTransferRoot | null {
    return this.allReadableRoots(resolved).find((root) => SecurityFilter.isWithinRoot(remotePath, [root.path])) ?? null;
  }

  private findWritableRoot(resolved: ResolvedNode, remotePath: string): WorkerNodeFileTransferRoot | null {
    return this.allWritableRoots(resolved).find((root) => SecurityFilter.isWithinRoot(remotePath, [root.path])) ?? null;
  }

  private allReadableRoots(resolved: ResolvedNode): WorkerNodeFileTransferRoot[] {
    return [
      ...resolved.fileTransfer.roots.filter((root) => root.read),
      ...resolved.node.capabilities.workingDirectories.map((pathValue, index) => ({
        id: `workingDirectory${index + 1}`,
        label: 'Working Directory',
        path: pathValue,
        read: true,
        write: true,
      })),
    ];
  }

  private allWritableRoots(resolved: ResolvedNode): WorkerNodeFileTransferRoot[] {
    return [
      ...resolved.fileTransfer.roots.filter((root) => root.write && !root.approvalRequired),
      ...resolved.node.capabilities.workingDirectories.map((pathValue, index) => ({
        id: `workingDirectory${index + 1}`,
        label: 'Working Directory',
        path: pathValue,
        read: true,
        write: true,
      })),
    ];
  }

  private classifyPath(
    resolved: ResolvedNode,
    remotePath: string,
    stat: FsStatResult | null,
  ): SafetyClassification {
    const root = this.findReadableRoot(resolved, remotePath);
    if (!root) return 'outsideRoots';
    if (SecurityFilter.isRestrictedPath(remotePath)) return 'sensitiveName';
    if (root.approvalRequired) return 'restricted';
    if ((stat?.size ?? 0) > resolved.fileTransfer.maxFileBytes) return 'tooLarge';
    return 'normal';
  }

  private selectReadableTransferRoots(
    fileTransfer: WorkerNodeFileTransferSummary,
    rootIds: string[] | undefined,
  ): WorkerNodeFileTransferRoot[] {
    const readable = fileTransfer.roots.filter((root) => root.read);
    if (!rootIds?.length) {
      return readable;
    }
    const byId = new Map(readable.map((root) => [root.id.toLowerCase(), root]));
    const selected: WorkerNodeFileTransferRoot[] = [];
    const seen = new Set<string>();
    for (const rootId of rootIds) {
      const key = rootId.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      const root = byId.get(key);
      if (!root) {
        continue;
      }
      selected.push(root);
      seen.add(key);
    }
    return selected;
  }

  private collectBrowserDownloadRootIds(
    fileTransfer: WorkerNodeFileTransferSummary,
  ): string[] {
    const readable = new Set(
      fileTransfer.roots
        .filter((root) => root.read)
        .map((root) => root.id.toLowerCase()),
    );
    const matchedRootIds = COLLECT_BROWSER_DOWNLOAD_ROOT_IDS.filter((rootId) =>
      readable.has(rootId.toLowerCase()),
    );
    return matchedRootIds.length > 0 ? matchedRootIds : COLLECT_BROWSER_DOWNLOAD_ROOT_IDS;
  }

  private firstPreferredRootCandidates(
    candidates: RemoteCandidate[],
    rootIds: string[],
  ): RemoteCandidate[] {
    for (const rootId of rootIds) {
      const matches = candidates.filter((candidate) => candidate.rootId.toLowerCase() === rootId.toLowerCase());
      if (matches.length > 0) {
        return matches;
      }
    }
    return candidates;
  }

  private toCandidate(entry: FsEntry, root: WorkerNodeFileTransferRoot): RemoteCandidate {
    return {
      path: entry.path,
      name: entry.name,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      extension: entry.extension ?? path.extname(entry.name).toLowerCase(),
      rootId: root.id,
      rootLabel: root.label,
      ...(root.approvalRequired === true ? { approvalRequired: true } : {}),
    };
  }

  private decorateEntry(resolved: ResolvedNode, entry: FsEntry): Record<string, unknown> {
    const root = this.findReadableRoot(resolved, entry.path);
    return {
      ...entry,
      extension: entry.extension ?? path.extname(entry.name).toLowerCase(),
      rootId: root?.id,
      rootLabel: root?.label,
    };
  }

  private async hashRemoteFile(nodeId: string, remotePath: string): Promise<string> {
    const read = await this.readRemoteFile(nodeId, remotePath);
    return sha256(Buffer.from(read.data, 'base64'));
  }

  private async readRemoteFile(nodeId: string, remotePath: string): Promise<FsReadFileResult> {
    return this.sendRpc<FsReadFileResult>(nodeId, COORDINATOR_TO_NODE.FS_READ_FILE, { path: remotePath });
  }

  private async sendRpc<T>(nodeId: string, method: string, params: unknown): Promise<T> {
    return getWorkerNodeConnectionServer().sendRpc<T>(nodeId, method, params);
  }

  private workspace(meta: FileTransferToolMeta): string {
    return path.resolve(this.options.resolveLocalWorkspace?.(meta.callerInstanceId) ?? process.cwd());
  }

  private async resolveLocalDestination(
    localPath: string | undefined,
    remotePath: string,
    meta: FileTransferToolMeta,
  ): Promise<string> {
    const workspace = this.workspace(meta);
    const destination = localPath
      ? resolveInsideWorkspace(workspace, localPath)
      : path.join(workspace, '_scratch', 'aio-transfers', `${randomUUID()}-${sanitizeBasename(remotePath)}`);
    if (SecurityFilter.isRestrictedPath(destination)) {
      throw new NodeFileTransferMcpError('local_write_refused', `Local destination is restricted: ${destination}`);
    }
    await assertClosestExistingPathInsideWorkspace(workspace, path.dirname(destination), 'Local destination directory');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await assertExistingPathInsideWorkspace(workspace, path.dirname(destination), 'Local destination directory');
    const destinationStat = await lstatOrNull(destination);
    if (destinationStat?.isSymbolicLink()) {
      throw new NodeFileTransferMcpError(
        'local_write_refused',
        `Local destination must not be a symbolic link: ${destination}`,
      );
    }
    return destination;
  }

  private async resolveLocalSource(localPath: string, meta: FileTransferToolMeta): Promise<string> {
    const workspace = this.workspace(meta);
    const source = resolveInsideWorkspace(workspace, localPath);
    if (SecurityFilter.isRestrictedPath(source)) {
      throw new NodeFileTransferMcpError('local_write_refused', `Local source is restricted: ${source}`);
    }
    await assertExistingPathInsideWorkspace(workspace, source, 'Local source');
    return source;
  }

  private defaultRemoteScratchPath(resolved: ResolvedNode, localPath: string): string {
    const scratchRoot = resolved.fileTransfer.roots.find((root) => root.id === 'scratch' && root.write)
      ?? resolved.fileTransfer.roots.find((root) => root.write)
      ?? this.allWritableRoots(resolved)[0];
    if (!scratchRoot) {
      throw new NodeFileTransferMcpError('remote_write_refused', `Node ${resolved.node.name} has no writable transfer root`);
    }
    const pathApi = isWindowsStylePath(scratchRoot.path) ? path.win32 : path.posix;
    return pathApi.join(scratchRoot.path, `${randomUUID()}-${sanitizeBasename(localPath)}`);
  }
}

function matchesFind(candidate: RemoteCandidate, args: FindNodeFilesArgs): boolean {
  if (args.query) {
    const query = args.query.toLowerCase();
    if (!candidate.name.toLowerCase().includes(query) && !candidate.path.toLowerCase().includes(query)) {
      return false;
    }
  }
  if (args.extensions?.length) {
    const wanted = new Set(args.extensions.map(normalizeExtension));
    if (!wanted.has(normalizeExtension(candidate.extension ?? path.extname(candidate.name)))) {
      return false;
    }
  }
  if (args.modifiedWithinDays) {
    const cutoff = Date.now() - args.modifiedWithinDays * 24 * 60 * 60 * 1000;
    if (candidate.modifiedAt < cutoff) return false;
  }
  if (args.minBytes !== undefined && candidate.size < args.minBytes) return false;
  if (args.maxBytes !== undefined && candidate.size > args.maxBytes) return false;
  return true;
}

function flattenEntries(entries: FsEntry[]): FsEntry[] {
  const out: FsEntry[] = [];
  for (const entry of entries) {
    out.push(entry);
    if (entry.children) out.push(...flattenEntries(entry.children));
  }
  return out;
}

function rootEntry(root: WorkerNodeFileTransferRoot): Record<string, unknown> {
  return {
    path: root.path,
    name: root.label,
    size: 0,
    extension: '',
    modifiedAt: 0,
    isDirectory: true,
    isSymlink: false,
    restricted: root.approvalRequired === true,
    rootId: root.id,
    rootLabel: root.label,
    read: root.read,
    write: root.write,
  };
}

function publicRoot(root: WorkerNodeFileTransferRoot): Record<string, unknown> {
  return {
    id: root.id,
    label: root.label,
    path: root.path,
    read: root.read,
    write: root.write,
    approvalRequired: root.approvalRequired === true,
  };
}

function audit(
  toolName: string,
  decision: 'allowed' | 'refused' | 'approval-required',
  node: WorkerNodeInfo,
  payload: {
    callerInstanceId?: string | null;
    sourcePath?: string;
    destinationPath?: string;
    size?: number;
    sha256?: string;
    refusalReason?: string;
  },
): void {
  logger.info('file_transfer_audit', {
    timestamp: Date.now(),
    toolName,
    nodeId: node.id,
    nodeName: node.name,
    decision,
    ...payload,
  });
}
