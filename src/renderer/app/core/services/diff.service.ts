/**
 * Diff Service - Compute and format file differences
 *
 * Features:
 * - Line-by-line diff computation
 * - Character-level diff within changed lines
 * - Unified and side-by-side diff formats
 * - Syntax highlighting integration
 */

import { Injectable } from '@angular/core';
import * as Diff from 'diff';

export interface DiffLine {
  type: 'add' | 'remove' | 'unchanged' | 'info';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  // For character-level diffs within a line
  changes?: Array<{ value: string; added?: boolean; removed?: boolean }>;
}

export interface DiffResult {
  oldContent: string;
  newContent: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  changes: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

@Injectable({
  providedIn: 'root',
})
export class DiffService {
  /**
   * Compute diff between two strings
   */
  computeDiff(oldContent: string, newContent: string): DiffResult {
    const lines: DiffLine[] = [];
    let additions = 0;
    let deletions = 0;

    // Use line-by-line diff
    const changes = Diff.diffLines(oldContent, newContent);

    let oldLineNum = 1;
    let newLineNum = 1;

    for (const change of changes) {
      const lineContents = change.value.split('\n');
      // Remove last empty element if string ends with newline
      if (lineContents[lineContents.length - 1] === '') {
        lineContents.pop();
      }

      for (const lineContent of lineContents) {
        if (change.added) {
          lines.push({
            type: 'add',
            content: lineContent,
            newLineNumber: newLineNum++,
          });
          additions++;
        } else if (change.removed) {
          lines.push({
            type: 'remove',
            content: lineContent,
            oldLineNumber: oldLineNum++,
          });
          deletions++;
        } else {
          lines.push({
            type: 'unchanged',
            content: lineContent,
            oldLineNumber: oldLineNum++,
            newLineNumber: newLineNum++,
          });
        }
      }
    }

    return {
      oldContent,
      newContent,
      lines,
      additions,
      deletions,
      changes: additions + deletions,
    };
  }

  /**
   * Compute diff with character-level changes for modified lines
   */
  computeDiffWithCharChanges(oldContent: string, newContent: string): DiffResult {
    const result = this.computeDiff(oldContent, newContent);

    // Find pairs of removed/added lines that are likely modifications
    const enhancedLines: DiffLine[] = [];
    let i = 0;

    while (i < result.lines.length) {
      const line = result.lines[i];

      // Look for remove followed by add (potential modification)
      if (line.type === 'remove' && i + 1 < result.lines.length) {
        const nextLine = result.lines[i + 1];
        if (nextLine.type === 'add') {
          // Compute character-level diff
          const charChanges = Diff.diffChars(line.content, nextLine.content);

          // Add removed line with char changes
          enhancedLines.push({
            ...line,
            changes: charChanges.map((c) => ({
              value: c.value,
              removed: c.removed,
              added: c.added,
            })),
          });

          // Add added line with char changes
          enhancedLines.push({
            ...nextLine,
            changes: charChanges.map((c) => ({
              value: c.value,
              removed: c.removed,
              added: c.added,
            })),
          });

          i += 2;
          continue;
        }
      }

      enhancedLines.push(line);
      i++;
    }

    return {
      ...result,
      lines: enhancedLines,
    };
  }

  /**
   * Get diff as hunks (groups of changes with context)
   */
  getDiffHunks(oldContent: string, newContent: string, contextLines = 3): DiffHunk[] {
    const result = this.computeDiff(oldContent, newContent);
    const hunks: DiffHunk[] = [];

    let currentHunk: DiffHunk | null = null;
    let contextBuffer: DiffLine[] = [];

    for (let i = 0; i < result.lines.length; i++) {
      const line = result.lines[i];
      const isChange = line.type === 'add' || line.type === 'remove';

      if (isChange) {
        if (!currentHunk) {
          // Start new hunk
          currentHunk = {
            oldStart: (line.oldLineNumber || 1) - contextBuffer.length,
            oldLines: 0,
            newStart: (line.newLineNumber || 1) - contextBuffer.length,
            newLines: 0,
            lines: [...contextBuffer],
          };

          // Add context to line counts
          for (const contextLine of contextBuffer) {
            if (contextLine.oldLineNumber) currentHunk.oldLines++;
            if (contextLine.newLineNumber) currentHunk.newLines++;
          }
        }

        currentHunk.lines.push(line);
        if (line.oldLineNumber) currentHunk.oldLines++;
        if (line.newLineNumber) currentHunk.newLines++;
        contextBuffer = [];
      } else {
        // Unchanged line
        if (currentHunk) {
          if (contextBuffer.length < contextLines * 2) {
            // Add to current hunk context
            currentHunk.lines.push(line);
            if (line.oldLineNumber) currentHunk.oldLines++;
            if (line.newLineNumber) currentHunk.newLines++;
            contextBuffer.push(line);
          } else {
            // End current hunk and start buffering context
            hunks.push(currentHunk);
            currentHunk = null;
            contextBuffer = [line];
          }
        } else {
          // Buffer context for potential next hunk
          contextBuffer.push(line);
          if (contextBuffer.length > contextLines) {
            contextBuffer.shift();
          }
        }
      }
    }

    // Don't forget the last hunk
    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }

  /**
   * Format diff for unified output (like git diff)
   */
  formatUnifiedDiff(
    oldContent: string,
    newContent: string,
    oldFileName = 'a/file',
    newFileName = 'b/file'
  ): string {
    const hunks = this.getDiffHunks(oldContent, newContent);
    const lines: string[] = [];

    lines.push(`--- ${oldFileName}`);
    lines.push(`+++ ${newFileName}`);

    for (const hunk of hunks) {
      lines.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
      );

      for (const line of hunk.lines) {
        const prefix =
          line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        lines.push(`${prefix}${line.content}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Parse a unified diff string into DiffResult
   */
  parseUnifiedDiff(diffString: string): DiffResult {
    const lines: DiffLine[] = [];
    let additions = 0;
    let deletions = 0;

    const diffLines = diffString.split('\n');
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of diffLines) {
      // Parse hunk header
      const hunkMatch = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (hunkMatch) {
        oldLineNum = parseInt(hunkMatch[1], 10);
        newLineNum = parseInt(hunkMatch[2], 10);
        lines.push({
          type: 'info',
          content: line,
        });
        continue;
      }

      // Skip header lines
      if (line.startsWith('---') || line.startsWith('+++')) {
        continue;
      }

      if (line.startsWith('+')) {
        lines.push({
          type: 'add',
          content: line.substring(1),
          newLineNumber: newLineNum++,
        });
        additions++;
      } else if (line.startsWith('-')) {
        lines.push({
          type: 'remove',
          content: line.substring(1),
          oldLineNumber: oldLineNum++,
        });
        deletions++;
      } else if (line.startsWith(' ') || line === '') {
        lines.push({
          type: 'unchanged',
          content: line.substring(1) || '',
          oldLineNumber: oldLineNum++,
          newLineNumber: newLineNum++,
        });
      }
    }

    return {
      oldContent: '',
      newContent: '',
      lines,
      additions,
      deletions,
      changes: additions + deletions,
    };
  }
}
