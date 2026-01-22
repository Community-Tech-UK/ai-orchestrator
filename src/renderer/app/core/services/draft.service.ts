/**
 * Draft Service - Manages message drafts across different views
 *
 * Provides persistent draft storage keyed by context (instanceId, 'verification', etc.)
 * so users don't lose their typed text when switching between views.
 * Also stores pending file attachments per context.
 */

import { Injectable, signal, computed } from '@angular/core';

// Special context keys for non-instance views
export const VERIFICATION_DRAFT_KEY = '__verification__';

@Injectable({
  providedIn: 'root'
})
export class DraftService {
  // Storage for drafts keyed by context
  private drafts = new Map<string, string>();

  // Storage for pending files keyed by context
  private pendingFiles = new Map<string, File[]>();

  // Signal to notify when any draft changes (for reactive updates)
  private _draftVersion = signal(0);

  // Expose version as readonly for components to track changes
  readonly version = this._draftVersion.asReadonly();

  /**
   * Get the draft for a given context
   */
  getDraft(contextKey: string): string {
    return this.drafts.get(contextKey) || '';
  }

  /**
   * Set the draft for a given context
   */
  setDraft(contextKey: string, text: string): void {
    if (text) {
      this.drafts.set(contextKey, text);
    } else {
      this.drafts.delete(contextKey);
    }
    this._draftVersion.update(v => v + 1);
  }

  /**
   * Clear the draft for a given context
   */
  clearDraft(contextKey: string): void {
    this.drafts.delete(contextKey);
    this._draftVersion.update(v => v + 1);
  }

  /**
   * Check if a draft exists for a context
   */
  hasDraft(contextKey: string): boolean {
    const draft = this.drafts.get(contextKey);
    return !!draft && draft.length > 0;
  }

  /**
   * Get all contexts with drafts (useful for debugging)
   */
  getAllDraftKeys(): string[] {
    return Array.from(this.drafts.keys());
  }

  /**
   * Get pending files for a given context
   */
  getPendingFiles(contextKey: string): File[] {
    return this.pendingFiles.get(contextKey) || [];
  }

  /**
   * Set pending files for a given context
   */
  setPendingFiles(contextKey: string, files: File[]): void {
    if (files && files.length > 0) {
      this.pendingFiles.set(contextKey, files);
    } else {
      this.pendingFiles.delete(contextKey);
    }
    this._draftVersion.update(v => v + 1);
  }

  /**
   * Add files to pending files for a context
   */
  addPendingFiles(contextKey: string, files: File[]): void {
    const existing = this.pendingFiles.get(contextKey) || [];
    this.pendingFiles.set(contextKey, [...existing, ...files]);
    this._draftVersion.update(v => v + 1);
  }

  /**
   * Remove a file from pending files for a context
   */
  removePendingFile(contextKey: string, file: File): void {
    const existing = this.pendingFiles.get(contextKey) || [];
    const filtered = existing.filter(f => f !== file);
    if (filtered.length > 0) {
      this.pendingFiles.set(contextKey, filtered);
    } else {
      this.pendingFiles.delete(contextKey);
    }
    this._draftVersion.update(v => v + 1);
  }

  /**
   * Clear pending files for a context
   */
  clearPendingFiles(contextKey: string): void {
    this.pendingFiles.delete(contextKey);
    this._draftVersion.update(v => v + 1);
  }

  /**
   * Check if there are pending files for a context
   */
  hasPendingFiles(contextKey: string): boolean {
    const files = this.pendingFiles.get(contextKey);
    return !!files && files.length > 0;
  }
}
