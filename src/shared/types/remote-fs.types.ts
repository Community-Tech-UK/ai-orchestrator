import type { NodePlatform } from './worker-node.types';

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  extension?: string;
  ignored: boolean;
  restricted: boolean;
  children?: FsEntry[];
}

export interface FsReadDirectoryParams {
  path: string;
  depth?: number;
  includeHidden?: boolean;
  cursor?: string;
  limit?: number;
}

export interface FsStatParams {
  path: string;
}

export interface FsSearchParams {
  query: string;
  maxResults?: number;
}

export interface FsWatchParams {
  path: string;
  recursive?: boolean;
}

export interface FsUnwatchParams {
  watchId: string;
}

export interface FsReadFileParams {
  path: string;
}

export interface FsReadFileResult {
  data: string; // base64-encoded file content
  size: number;
  mimeType: string;
}

export interface FsWriteFileParams {
  path: string;
  data: string; // base64-encoded file content
  /** Create intermediate directories if they don't exist (default: true) */
  mkdirp?: boolean;
}

export interface FsReadDirectoryResult {
  entries: FsEntry[];
  cursor?: string;
  truncated: boolean;
}

export interface FsStatResult {
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  platform: NodePlatform;
  withinBrowsableRoot: boolean;
}

export interface FsSearchResult {
  results: FsProjectMatch[];
}

export interface FsProjectMatch {
  path: string;
  name: string;
  markers: string[];
  root: string;
}

export interface FsWatchResult {
  watchId: string;
}

export interface FsEventNotification {
  watchId: string;
  events: FsChangeEvent[];
}

export interface FsChangeEvent {
  type: 'add' | 'change' | 'delete';
  path: string;
  isDirectory: boolean;
}

export type FsErrorCode =
  | 'ENOENT'
  | 'EACCES'
  | 'EOUTOFSCOPE'
  | 'ETIMEOUT'
  | 'ENOTDIR';

export interface FsErrorData {
  fsCode: FsErrorCode;
  path: string;
  retryable: boolean;
  suggestion?: string;
}

export interface DiscoveredProject {
  path: string;
  name: string;
  markers: string[];
}
