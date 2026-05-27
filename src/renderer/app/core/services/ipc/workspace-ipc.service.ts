/**
 * Workspace IPC Service - Renderer-side wrapper around the unified
 * `workspace:*` IPC calls.
 *
 * Today this is a single fire-and-forget method: `hintActive(path, nodeId?)`
 * tells the main-process that this workspace is the user's current focus.
 * The handler fans the hint out to every coordinator that subscribes to
 * "workspace is present" events (codemem prewarm, codebase auto-index,
 * project knowledge mirror).
 *
 * The method is intentionally non-throwing — these hints are best-effort
 * optimisations, and the renderer should never crash if a coordinator is
 * disabled or the IPC bridge is unavailable (e.g. when running the renderer
 * in `ng serve` outside Electron).
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class WorkspaceIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  /**
   * Hint that this workspace is the user's active focus. Best-effort —
   * swallows errors and returns false on any failure.
   *
   * Pass a non-empty absolute or app-relative directory path. Empty / null
   * inputs are no-ops. Pass `nodeId` for remote workspaces — the main-
   * process fan-out skips remote hints because each remote node owns
   * its own coordinators.
   */
  async hintActive(path: string | null | undefined, nodeId?: string | null): Promise<boolean> {
    if (!path) return false;
    const trimmed = path.trim();
    if (!trimmed) return false;
    if (!this.api?.workspaceHintActive) return false;

    try {
      const response = await this.api.workspaceHintActive({
        path: trimmed,
        nodeId: nodeId ?? null,
      });
      return Boolean(response?.success);
    } catch {
      // Never let a hint failure bubble — the spawn-time safety nets in the
      // main process still cold-start each subsystem if the user goes on to
      // spawn an instance.
      return false;
    }
  }
}
