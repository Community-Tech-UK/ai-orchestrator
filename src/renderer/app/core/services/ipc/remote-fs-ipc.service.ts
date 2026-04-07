// src/renderer/app/core/services/ipc/remote-fs-ipc.service.ts
import { Injectable } from '@angular/core';
import type {
  FsReadDirectoryResult,
  FsStatResult,
  FsSearchResult,
  FsWatchResult,
} from '../../../../../shared/types/remote-fs.types';

interface IpcResult {
  success: boolean;
  data?: unknown;
  error?: { message: string };
}

interface ElectronAPI {
  remoteFsReadDirectory(
    nodeId: string,
    path: string,
    options?: { depth?: number; includeHidden?: boolean; cursor?: string; limit?: number }
  ): Promise<IpcResult>;

  remoteFsStat(nodeId: string, path: string): Promise<IpcResult>;

  remoteFsSearch(nodeId: string, query: string, maxResults?: number): Promise<IpcResult>;

  remoteFsWatch(nodeId: string, path: string, recursive?: boolean): Promise<IpcResult>;

  remoteFsUnwatch(nodeId: string, watchId: string): Promise<IpcResult>;
}

@Injectable({ providedIn: 'root' })
export class RemoteFsIpcService {
  private readonly api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;

  async readDirectory(
    nodeId: string,
    path: string,
    options?: { depth?: number; includeHidden?: boolean; cursor?: string; limit?: number }
  ): Promise<FsReadDirectoryResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsReadDirectory(nodeId, path, options);
    if (!result.success) throw new Error(result.error?.message ?? 'Failed to read directory');
    return result.data as FsReadDirectoryResult;
  }

  async stat(nodeId: string, path: string): Promise<FsStatResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsStat(nodeId, path);
    if (!result.success) throw new Error(result.error?.message ?? 'Failed to stat path');
    return result.data as FsStatResult;
  }

  async search(nodeId: string, query: string, maxResults?: number): Promise<FsSearchResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsSearch(nodeId, query, maxResults);
    if (!result.success) throw new Error(result.error?.message ?? 'Failed to search');
    return result.data as FsSearchResult;
  }

  async watch(nodeId: string, path: string, recursive?: boolean): Promise<FsWatchResult | null> {
    if (!this.api) return null;
    const result = await this.api.remoteFsWatch(nodeId, path, recursive);
    if (!result.success) throw new Error(result.error?.message ?? 'Failed to watch path');
    return result.data as FsWatchResult;
  }

  async unwatch(nodeId: string, watchId: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.remoteFsUnwatch(nodeId, watchId);
    if (!result.success) throw new Error(result.error?.message ?? 'Failed to unwatch');
  }
}
