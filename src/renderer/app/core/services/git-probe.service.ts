import { Injectable, inject } from '@angular/core';
import { CommandIpcService } from './ipc';

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

@Injectable({ providedIn: 'root' })
export class GitProbeService {
  private commandIpc = inject(CommandIpcService);
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 30_000;

  async isGitRepo(workingDirectory: string | null | undefined): Promise<boolean | undefined> {
    if (!workingDirectory) return undefined;

    const now = Date.now();
    const cached = this.cache.get(workingDirectory);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const response = await this.commandIpc.isWorkspaceGitRepo(workingDirectory);
    if (!response.success || typeof response.data !== 'boolean') {
      return undefined;
    }

    this.cache.set(workingDirectory, {
      value: response.data,
      expiresAt: now + this.ttlMs,
    });
    return response.data;
  }

  clear(workingDirectory?: string): void {
    if (workingDirectory) {
      this.cache.delete(workingDirectory);
      return;
    }
    this.cache.clear();
  }
}
