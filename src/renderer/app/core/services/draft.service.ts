/**
 * Draft Service - Manages message drafts across different views
 *
 * Provides persistent draft storage keyed by context (instanceId, 'verification', etc.)
 * so users don't lose their typed text when switching between views.
 * Also stores pending file attachments per context.
 */

import { Injectable, computed, signal } from '@angular/core';

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

  // Storage for pending folder paths keyed by context
  private pendingFolders = new Map<string, string[]>();

  // Split version signals: text changes are debounced, attachment changes are immediate
  private _textVersion = signal(0);
  private _attachmentVersion = signal(0);
  private textDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TEXT_DEBOUNCE_MS = 250;

  // Expose separate version signals for selective tracking
  readonly textVersion = this._textVersion.asReadonly();
  readonly attachmentVersion = this._attachmentVersion.asReadonly();

  // Combined version for backward compatibility (any change triggers)
  readonly version = computed(() => this._textVersion() + this._attachmentVersion());

  private bumpTextVersion(): void {
    if (this.textDebounceTimer !== null) {
      clearTimeout(this.textDebounceTimer);
    }
    this.textDebounceTimer = setTimeout(() => {
      this.textDebounceTimer = null;
      this._textVersion.update(v => v + 1);
    }, DraftService.TEXT_DEBOUNCE_MS);
  }

  private bumpAttachmentVersion(): void {
    this._attachmentVersion.update(v => v + 1);
  }

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
    this.bumpTextVersion();
  }

  /**
   * Clear the draft for a given context
   */
  clearDraft(contextKey: string): void {
    this.drafts.delete(contextKey);
    this.bumpTextVersion();
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
    this.bumpAttachmentVersion();
  }

  /**
   * Add files to pending files for a context
   */
  addPendingFiles(contextKey: string, files: File[]): void {
    const existing = this.pendingFiles.get(contextKey) || [];
    this.pendingFiles.set(contextKey, [...existing, ...files]);
    this.bumpAttachmentVersion();
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
    this.bumpAttachmentVersion();
  }

  /**
   * Clear pending files for a context
   */
  clearPendingFiles(contextKey: string): void {
    this.pendingFiles.delete(contextKey);
    this.bumpAttachmentVersion();
  }

  /**
   * Check if there are pending files for a context
   */
  hasPendingFiles(contextKey: string): boolean {
    const files = this.pendingFiles.get(contextKey);
    return !!files && files.length > 0;
  }

  /**
   * Get pending folder paths for a given context
   */
  getPendingFolders(contextKey: string): string[] {
    return this.pendingFolders.get(contextKey) || [];
  }

  /**
   * Add a folder path to pending folders for a context
   */
  addPendingFolder(contextKey: string, folderPath: string): void {
    const existing = this.pendingFolders.get(contextKey) || [];
    // Avoid duplicates
    if (!existing.includes(folderPath)) {
      this.pendingFolders.set(contextKey, [...existing, folderPath]);
      this.bumpAttachmentVersion();
    }
  }

  /**
   * Remove a folder path from pending folders for a context
   */
  removePendingFolder(contextKey: string, folderPath: string): void {
    const existing = this.pendingFolders.get(contextKey) || [];
    const filtered = existing.filter(f => f !== folderPath);
    if (filtered.length > 0) {
      this.pendingFolders.set(contextKey, filtered);
    } else {
      this.pendingFolders.delete(contextKey);
    }
    this.bumpAttachmentVersion();
  }

  /**
   * Clear pending folders for a context
   */
  clearPendingFolders(contextKey: string): void {
    this.pendingFolders.delete(contextKey);
    this.bumpAttachmentVersion();
  }

  /**
   * Check if there are pending folders for a context
   */
  hasPendingFolders(contextKey: string): boolean {
    const folders = this.pendingFolders.get(contextKey);
    return !!folders && folders.length > 0;
  }
}
