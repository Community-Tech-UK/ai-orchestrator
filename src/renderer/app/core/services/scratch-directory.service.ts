/**
 * Scratch Directory Service
 *
 * Holds the absolute path to the general-chat scratch directory (resolved by
 * the main process — `<home>/.ai-orchestrator/scratch`). General chats are
 * regular sessions whose working directory is this folder; the instance list
 * groups any session under this path into a single "Chats" rail group.
 *
 * The path is fetched once at startup and cached in a signal so the (pure,
 * synchronous) project-grouping logic can compare against it.
 */

import { Injectable, inject, signal } from '@angular/core';
import { AppIpcService } from './ipc/app-ipc.service';

@Injectable({ providedIn: 'root' })
export class ScratchDirectoryService {
  private readonly appIpc = inject(AppIpcService);

  private readonly _dir = signal<string | null>(null);
  /** Absolute scratch-directory path, or null until resolved / outside Electron. */
  readonly dir = this._dir.asReadonly();

  private initPromise: Promise<void> | null = null;

  /** Fetch the scratch directory from the main process once and cache it. */
  init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.appIpc
      .getScratchDirectory()
      .then((path) => {
        if (path) {
          this._dir.set(path);
        }
      })
      .catch(() => {
        // Non-fatal: general chats simply won't get the special "Chats" group
        // until the path resolves; the existing no-workspace handling remains.
      });
    return this.initPromise;
  }

  /** True when the given working directory is the general-chat scratch folder. */
  isScratch(workingDirectory: string | null | undefined): boolean {
    const dir = this._dir();
    if (!dir) {
      return false;
    }
    return this.normalize(workingDirectory) === this.normalize(dir);
  }

  private normalize(p: string | null | undefined): string {
    return (p ?? '').trim().replace(/[/\\]+$/, '').toLowerCase();
  }
}
