/**
 * Multi-Edit Manager
 *
 * Provides atomic batch editing of multiple files.
 * All edits succeed or all fail (rollback on error).
 */

import * as fs from 'fs';
import * as path from 'path';
import { diffLines } from 'diff';
import { getSnapshotManager } from '../snapshots/snapshot-manager';

// ============================================
// Types
// ============================================

export interface EditOperation {
  filePath: string;    // Absolute path to the file
  oldString: string;   // Text to find and replace
  newString: string;   // Replacement text
  replaceAll?: boolean; // Replace all occurrences (default: false)
}

export interface EditResult {
  filePath: string;
  success: boolean;
  error?: string;
  diff?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
}

export interface MultiEditResult {
  success: boolean;
  results: EditResult[];
  totalFiles: number;
  totalEdits: number;
  appliedEdits: number;
  error?: string;
}

export interface MultiEditPreview {
  valid: boolean;
  edits: Array<{
    filePath: string;
    diff: string;
    additions: number;
    deletions: number;
    error?: string;
  }>;
  errors: string[];
}

// ============================================
// Multi-Edit Manager
// ============================================

class MultiEditManager {
  private fileCache: Map<string, string> = new Map();
  private instanceId?: string;

  /**
   * Set the instance ID for snapshot integration
   */
  setInstanceId(instanceId: string): void {
    this.instanceId = instanceId;
  }

  /**
   * Preview edits without applying them
   * Returns what would happen if edits were applied
   */
  async preview(edits: EditOperation[]): Promise<MultiEditPreview> {
    const result: MultiEditPreview = {
      valid: true,
      edits: [],
      errors: [],
    };

    // Validate and preview each edit
    for (const edit of edits) {
      const previewResult = await this.previewSingleEdit(edit);
      result.edits.push(previewResult);

      if (previewResult.error) {
        result.valid = false;
        result.errors.push(`${edit.filePath}: ${previewResult.error}`);
      }
    }

    return result;
  }

  /**
   * Apply multiple edits atomically
   * All edits succeed or all are rolled back
   */
  async apply(
    edits: EditOperation[],
    options: {
      instanceId?: string;
      takeSnapshots?: boolean;
    } = {}
  ): Promise<MultiEditResult> {
    const instanceId = options.instanceId || this.instanceId;
    const takeSnapshots = options.takeSnapshots !== false;
    const snapshotManager = getSnapshotManager();

    const result: MultiEditResult = {
      success: false,
      results: [],
      totalFiles: new Set(edits.map((e) => e.filePath)).size,
      totalEdits: edits.length,
      appliedEdits: 0,
    };

    // Validation phase - check all edits before applying any
    const validationErrors: string[] = [];
    for (const edit of edits) {
      const error = await this.validateEdit(edit);
      if (error) {
        validationErrors.push(`${edit.filePath}: ${error}`);
      }
    }

    if (validationErrors.length > 0) {
      result.error = `Validation failed:\n${validationErrors.join('\n')}`;
      return result;
    }

    // Group edits by file for efficient processing
    const editsByFile = new Map<string, EditOperation[]>();
    for (const edit of edits) {
      const existing = editsByFile.get(edit.filePath) || [];
      existing.push(edit);
      editsByFile.set(edit.filePath, existing);
    }

    // Track original content for rollback
    const originalContent = new Map<string, string>();
    const modifiedFiles: string[] = [];

    try {
      // Take snapshots and apply edits file by file
      for (const [filePath, fileEdits] of editsByFile) {
        // Read original content
        let content: string;
        if (fs.existsSync(filePath)) {
          content = fs.readFileSync(filePath, 'utf-8');
        } else {
          content = '';
        }
        originalContent.set(filePath, content);

        // Take snapshot before modification
        if (takeSnapshots && instanceId) {
          await snapshotManager.takeSnapshot(filePath, instanceId);
        }

        // Apply all edits for this file in order
        let currentContent = content;
        const fileResults: EditResult[] = [];

        for (const edit of fileEdits) {
          const editResult = this.applySingleEdit(currentContent, edit);
          fileResults.push({
            filePath: edit.filePath,
            ...editResult,
          });

          if (!editResult.success) {
            throw new Error(`Edit failed for ${filePath}: ${editResult.error}`);
          }

          currentContent = editResult.after!;
          result.appliedEdits++;
        }

        // Write the final content
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, currentContent, 'utf-8');
        modifiedFiles.push(filePath);

        // Add results
        result.results.push(...fileResults);
      }

      result.success = true;
    } catch (error) {
      // Rollback all changes
      for (const filePath of modifiedFiles) {
        const original = originalContent.get(filePath);
        if (original !== undefined) {
          if (original === '' && !fs.existsSync(filePath)) {
            // File was created, remove it
            try {
              fs.unlinkSync(filePath);
            } catch {
              // Ignore if file doesn't exist
            }
          } else {
            // Restore original content
            fs.writeFileSync(filePath, original, 'utf-8');
          }
        }
      }

      result.success = false;
      result.error = (error as Error).message;
    }

    return result;
  }

  /**
   * Validate a single edit operation
   */
  private async validateEdit(edit: EditOperation): Promise<string | null> {
    // Check that paths are absolute
    if (!path.isAbsolute(edit.filePath)) {
      return 'File path must be absolute';
    }

    // Check that oldString and newString are different
    if (edit.oldString === edit.newString) {
      return 'oldString and newString must be different';
    }

    // If oldString is empty, this is a file creation
    if (edit.oldString === '') {
      if (fs.existsSync(edit.filePath)) {
        return 'File already exists (use non-empty oldString to edit)';
      }
      return null;
    }

    // Check that file exists
    if (!fs.existsSync(edit.filePath)) {
      return 'File does not exist';
    }

    // Check that oldString can be found in file
    try {
      const content = fs.readFileSync(edit.filePath, 'utf-8');
      if (!content.includes(edit.oldString)) {
        // Try trimmed match
        const trimmedOld = edit.oldString.trim();
        if (!content.includes(trimmedOld)) {
          return 'oldString not found in file';
        }
      }
    } catch (err) {
      return `Cannot read file: ${(err as Error).message}`;
    }

    return null;
  }

  /**
   * Preview a single edit
   */
  private async previewSingleEdit(
    edit: EditOperation
  ): Promise<{
    filePath: string;
    diff: string;
    additions: number;
    deletions: number;
    error?: string;
  }> {
    const error = await this.validateEdit(edit);
    if (error) {
      return {
        filePath: edit.filePath,
        diff: '',
        additions: 0,
        deletions: 0,
        error,
      };
    }

    // Get current content
    let content: string;
    if (edit.oldString === '' || !fs.existsSync(edit.filePath)) {
      content = '';
    } else {
      content = fs.readFileSync(edit.filePath, 'utf-8');
    }

    // Apply edit
    const result = this.applySingleEdit(content, edit);

    return {
      filePath: edit.filePath,
      diff: result.diff || '',
      additions: result.additions || 0,
      deletions: result.deletions || 0,
      error: result.error,
    };
  }

  /**
   * Apply a single edit to content
   */
  private applySingleEdit(
    content: string,
    edit: EditOperation
  ): Omit<EditResult, 'filePath'> {
    try {
      let newContent: string;

      // Handle file creation (empty oldString)
      if (edit.oldString === '') {
        newContent = edit.newString;
      } else {
        // Try exact match first
        if (content.includes(edit.oldString)) {
          if (edit.replaceAll) {
            newContent = content.split(edit.oldString).join(edit.newString);
          } else {
            newContent = content.replace(edit.oldString, edit.newString);
          }
        } else {
          // Try trimmed match
          const trimmedOld = edit.oldString.trim();
          if (content.includes(trimmedOld)) {
            if (edit.replaceAll) {
              newContent = content.split(trimmedOld).join(edit.newString.trim());
            } else {
              newContent = content.replace(trimmedOld, edit.newString.trim());
            }
          } else {
            // Try line-by-line match with trimming
            const result = this.flexibleReplace(content, edit.oldString, edit.newString);
            if (result !== null) {
              newContent = result;
            } else {
              return {
                success: false,
                error: 'Could not find oldString in file (tried exact, trimmed, and line-by-line matching)',
              };
            }
          }
        }
      }

      // Calculate diff
      const diff = this.calculateDiff(content, newContent, edit.filePath);

      return {
        success: true,
        diff: diff.diff,
        before: content,
        after: newContent,
        additions: diff.additions,
        deletions: diff.deletions,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Flexible replacement that handles whitespace differences
   */
  private flexibleReplace(
    content: string,
    oldString: string,
    newString: string
  ): string | null {
    // Split into lines and try to match by trimmed lines
    const contentLines = content.split('\n');
    const oldLines = oldString.split('\n');
    const newLines = newString.split('\n');

    // Find the start of the match
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let matches = true;

      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trim() !== oldLines[j].trim()) {
          matches = false;
          break;
        }
      }

      if (matches) {
        // Found a match - replace while preserving indentation of first line
        const indent = contentLines[i].match(/^(\s*)/)?.[1] || '';
        const replacementLines = newLines.map((line, idx) => {
          if (idx === 0) return indent + line.trimStart();
          // Preserve relative indentation from newString
          const originalIndent = oldLines[idx]?.match(/^(\s*)/)?.[1]?.length || 0;
          const newIndent = line.match(/^(\s*)/)?.[1]?.length || 0;
          const indentDiff = newIndent - originalIndent;
          const baseIndent = contentLines[i + idx]?.match(/^(\s*)/)?.[1]?.length || 0;
          const targetIndent = Math.max(0, baseIndent + indentDiff);
          return ' '.repeat(targetIndent) + line.trimStart();
        });

        const result = [
          ...contentLines.slice(0, i),
          ...replacementLines,
          ...contentLines.slice(i + oldLines.length),
        ].join('\n');

        return result;
      }
    }

    return null;
  }

  /**
   * Calculate unified diff between two strings
   */
  private calculateDiff(
    before: string,
    after: string,
    filePath: string
  ): { diff: string; additions: number; deletions: number } {
    const changes = diffLines(before, after);

    let additions = 0;
    let deletions = 0;
    const diffOutput: string[] = [];

    diffOutput.push(`--- a/${path.basename(filePath)}`);
    diffOutput.push(`+++ b/${path.basename(filePath)}`);

    for (const change of changes) {
      const lines = change.value.split('\n').filter((l: string) => l !== '' || change.value.endsWith('\n'));

      if (change.added) {
        additions += lines.length;
        for (const line of lines) {
          diffOutput.push(`+${line}`);
        }
      } else if (change.removed) {
        deletions += lines.length;
        for (const line of lines) {
          diffOutput.push(`-${line}`);
        }
      } else {
        // Context lines
        for (const line of lines.slice(0, 3)) {
          diffOutput.push(` ${line}`);
        }
        if (lines.length > 6) {
          diffOutput.push('@@ ... @@');
        }
        for (const line of lines.slice(-3)) {
          diffOutput.push(` ${line}`);
        }
      }
    }

    return {
      diff: diffOutput.join('\n'),
      additions,
      deletions,
    };
  }

  /**
   * Clear the file cache
   */
  clearCache(): void {
    this.fileCache.clear();
  }
}

// ============================================
// Singleton Instance
// ============================================

let multiEditManager: MultiEditManager | null = null;

export function getMultiEditManager(): MultiEditManager {
  if (!multiEditManager) {
    multiEditManager = new MultiEditManager();
  }
  return multiEditManager;
}

export { MultiEditManager };
