/**
 * View Layout Service - Manages panel sizes and layout persistence
 * Debounces save operations to avoid excessive localStorage writes
 */

import { Injectable, signal } from '@angular/core';
import { readStorage, writeStorage, removeStorage, type StorageField } from '../../shared/utils/typed-storage';

export interface ViewLayout {
  sidebarWidth: number;
  fileExplorerWidth: number;
  historySidebarWidth: number;
  sourceControlWidth: number;
}

const DEFAULT_LAYOUT: ViewLayout = {
  sidebarWidth: 320,
  fileExplorerWidth: 260,
  historySidebarWidth: 350,
  sourceControlWidth: 320,
};

const DEBOUNCE_MS = 500;

// Keep version: 2 so existing user widths are preserved. New optional fields
// are filled in by merging DEFAULT_LAYOUT first in `load()` below.
const LAYOUT_FIELD: StorageField<ViewLayout> = {
  key: 'view-layout',
  version: 2,
  defaultValue: DEFAULT_LAYOUT,
};

@Injectable({
  providedIn: 'root',
})
export class ViewLayoutService {
  private layout = signal<ViewLayout>(this.load());
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Get current sidebar width */
  get sidebarWidth(): number {
    return this.layout().sidebarWidth;
  }

  /** Get current file explorer width */
  get fileExplorerWidth(): number {
    return this.layout().fileExplorerWidth;
  }

  /** Get current history sidebar width */
  get historySidebarWidth(): number {
    return this.layout().historySidebarWidth;
  }

  /** Get current source control panel width */
  get sourceControlWidth(): number {
    return this.layout().sourceControlWidth;
  }

  /** Update sidebar width with debounced persistence */
  setSidebarWidth(width: number): void {
    const clamped = Math.max(250, Math.min(460, width));
    this.layout.update(l => ({ ...l, sidebarWidth: clamped }));
    this.debounceSave();
  }

  /** Update file explorer width with debounced persistence */
  setFileExplorerWidth(width: number): void {
    const clamped = Math.max(180, Math.min(500, width));
    this.layout.update(l => ({ ...l, fileExplorerWidth: clamped }));
    this.debounceSave();
  }

  /** Update history sidebar width with debounced persistence */
  setHistorySidebarWidth(width: number): void {
    const clamped = Math.max(240, Math.min(560, width));
    this.layout.update(l => ({ ...l, historySidebarWidth: clamped }));
    this.debounceSave();
  }

  /** Update source control panel width with debounced persistence */
  setSourceControlWidth(width: number): void {
    const clamped = Math.max(220, Math.min(500, width));
    this.layout.update(l => ({ ...l, sourceControlWidth: clamped }));
    this.debounceSave();
  }

  /** Reset all layout to defaults */
  reset(): void {
    this.layout.set({ ...DEFAULT_LAYOUT });
    this.saveNow();

    removeStorage('sidebarWidth');
    removeStorage('file-explorer-width');
    removeStorage('instance-list-order');
  }

  /** Load layout from localStorage */
  private load(): ViewLayout {
    const stored = readStorage(LAYOUT_FIELD);
    // Merge with defaults so newly-added fields (e.g. sourceControlWidth)
    // pick up their default when reading an older payload that predates them.
    const merged: ViewLayout = { ...DEFAULT_LAYOUT, ...stored };
    // Guard against the old stale sidebarWidth=390 default that was in early builds.
    if (merged.sidebarWidth === 390) {
      return { ...merged, sidebarWidth: DEFAULT_LAYOUT.sidebarWidth };
    }
    return merged;
  }

  /** Debounced save to localStorage */
  private debounceSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveNow();
    }, DEBOUNCE_MS);
  }

  /** Save immediately to localStorage */
  private saveNow(): void {
    writeStorage(LAYOUT_FIELD, this.layout());
  }
}
