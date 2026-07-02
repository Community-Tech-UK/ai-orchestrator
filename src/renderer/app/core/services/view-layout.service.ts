/**
 * View Layout Service - Manages panel sizes, layout presets, and persistence.
 * Debounces save operations to avoid excessive localStorage writes.
 */

import { Injectable, computed, signal } from '@angular/core';
import { readStorage, writeStorage, removeStorage, type StorageField } from '../../shared/utils/typed-storage';

/** Named workspace layouts (copilot_todo.md item 9). */
export type WorkspacePresetId = 'coding' | 'research' | 'review' | 'monitoring';

/** Which dashboard panels a preset wants visible. */
export interface WorkspacePanelVisibility {
  sidebar: boolean;
  fileExplorer: boolean;
  sourceControl: boolean;
  controlPlane: boolean;
  /** Side-chat panel (right rail). Optional — presets default to closed. */
  sideChat?: boolean;
}

export interface WorkspacePreset {
  id: WorkspacePresetId;
  label: string;
  description: string;
  panels: WorkspacePanelVisibility;
}

/**
 * Built-in workspace presets. Panels that are not eligible in the current
 * context (e.g. file explorer with no instance selected) are simply ignored
 * by the dashboard when a preset is applied.
 */
export const WORKSPACE_PRESETS: Record<WorkspacePresetId, WorkspacePreset> = {
  coding: {
    id: 'coding',
    label: 'Coding',
    description: 'Sessions and the file explorer for hands-on editing.',
    panels: { sidebar: true, fileExplorer: true, sourceControl: false, controlPlane: false },
  },
  research: {
    id: 'research',
    label: 'Research',
    description: 'A wide, distraction-free workspace.',
    panels: { sidebar: true, fileExplorer: false, sourceControl: false, controlPlane: false },
  },
  review: {
    id: 'review',
    label: 'Review',
    description: 'Source control changes alongside the workspace.',
    panels: { sidebar: true, fileExplorer: false, sourceControl: true, controlPlane: false },
  },
  monitoring: {
    id: 'monitoring',
    label: 'Monitoring',
    description: 'Control plane open for agents, search, and usage.',
    panels: { sidebar: true, fileExplorer: false, sourceControl: false, controlPlane: true },
  },
};

export interface ViewLayout {
  sidebarWidth: number;
  fileExplorerWidth: number;
  historySidebarWidth: number;
  sourceControlWidth: number;
  sideChatWidth: number;
  /** Last-applied workspace preset, or null when the layout is custom. */
  activePreset: WorkspacePresetId | null;
  /** Whether the control plane is docked into the layout vs floating (item 7). */
  controlPlanePinned: boolean;
}

const DEFAULT_LAYOUT: ViewLayout = {
  sidebarWidth: 320,
  fileExplorerWidth: 260,
  historySidebarWidth: 350,
  sourceControlWidth: 320,
  sideChatWidth: 380,
  activePreset: null,
  controlPlanePinned: false,
};

const DEBOUNCE_MS = 500;

// Keep version: 2 so existing user widths are preserved. New optional fields
// are filled in by merging DEFAULT_LAYOUT first in `load()` below.
const LAYOUT_FIELD: StorageField<ViewLayout> = {
  key: 'view-layout',
  version: 2,
  defaultValue: DEFAULT_LAYOUT,
};

function isWorkspacePresetId(value: unknown): value is WorkspacePresetId {
  return typeof value === 'string' && value in WORKSPACE_PRESETS;
}

@Injectable({
  providedIn: 'root',
})
export class ViewLayoutService {
  private layout = signal<ViewLayout>(this.load());
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  /** The available workspace presets, in display order. */
  readonly presets: readonly WorkspacePreset[] = Object.values(WORKSPACE_PRESETS);

  /** The last-applied preset id (reactive), or null for a custom layout. */
  readonly activePreset = computed(() => this.layout().activePreset);

  /**
   * Whether the control plane is pinned — docked into the layout as its own
   * column rather than floating as an overlay (copilot_todo.md item 7).
   */
  readonly controlPlanePinned = computed(() => this.layout().controlPlanePinned);

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

  /** Get current side-chat panel width */
  get sideChatWidth(): number {
    return this.layout().sideChatWidth;
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

  /** Update side-chat panel width with debounced persistence */
  setSideChatWidth(width: number): void {
    const clamped = Math.max(280, Math.min(560, width));
    this.layout.update(l => ({ ...l, sideChatWidth: clamped }));
    this.debounceSave();
  }

  /** Look up a preset definition by id. */
  getPreset(id: WorkspacePresetId): WorkspacePreset {
    return WORKSPACE_PRESETS[id];
  }

  /**
   * Record the active preset. Pass `null` to mark the layout as custom (e.g.
   * after the user manually toggles a panel away from the preset's shape).
   */
  setActivePreset(id: WorkspacePresetId | null): void {
    if (this.layout().activePreset === id) {
      return;
    }
    this.layout.update(l => ({ ...l, activePreset: id }));
    this.debounceSave();
  }

  /**
   * Set whether the control plane is pinned (docked into the layout) or left
   * floating as an overlay. Persisted with a debounced save so the choice
   * survives reloads (copilot_todo.md item 7).
   */
  setControlPlanePinned(pinned: boolean): void {
    if (this.layout().controlPlanePinned === pinned) {
      return;
    }
    this.layout.update(l => ({ ...l, controlPlanePinned: pinned }));
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
    // Merge with defaults so newly-added fields (e.g. sourceControlWidth,
    // activePreset) pick up their default when reading an older payload.
    const merged: ViewLayout = { ...DEFAULT_LAYOUT, ...stored };
    // Guard against the old stale sidebarWidth=390 default that was in early builds.
    if (merged.sidebarWidth === 390) {
      merged.sidebarWidth = DEFAULT_LAYOUT.sidebarWidth;
    }
    // Guard against an unknown preset id from a newer/older build.
    if (!isWorkspacePresetId(merged.activePreset)) {
      merged.activePreset = null;
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
