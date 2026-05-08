import { mkdir, writeFile, rm, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogger } from '../logging/logger';
import type { LoopAttachment } from '@contracts/schemas/loop';

const logger = getLogger('LoopAttachments');

/** Workspace-relative folder root for loop attachment storage. */
export const LOOP_ATTACHMENT_ROOT = '.aio-loop-attachments';

/** Maximum bytes per attachment we'll persist to workspace. Larger files are
 *  skipped with a warning; the prompt still references them so the user knows. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Strip path separators, control chars, and other unfriendly bytes. Keeps
 * dots so file extensions survive. Falls back to "file" if the result is
 * empty after sanitization.
 */
export function sanitizeAttachmentFilename(name: string): string {
  const base = name.replace(/[/\\]/g, '_');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  // Strip leading dots/underscores/hyphens so we don't accidentally produce
  // dotfiles, hidden files, or names that look like CLI flags.
  const stripped = cleaned.replace(/^[._-]+/, '');
  // Reject results that contain no alphanumerics — fall back to a safe label.
  return /[a-zA-Z0-9]/.test(stripped) ? stripped : 'file';
}

/**
 * Resolve filename collisions by appending `_1`, `_2`, … before the
 * extension. Pure function — no filesystem access.
 */
export function dedupeFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const safe = sanitizeAttachmentFilename(raw);
    const count = seen.get(safe) ?? 0;
    seen.set(safe, count + 1);
    if (count === 0) return safe;
    const dot = safe.lastIndexOf('.');
    if (dot <= 0) return `${safe}_${count}`;
    return `${safe.slice(0, dot)}_${count}${safe.slice(dot)}`;
  });
}

export interface SavedAttachment {
  /** Sanitized filename used on disk. */
  filename: string;
  /** Path relative to the workspace root (forward slashes for cross-platform prompt rendering). */
  relativePath: string;
  /** Number of bytes actually written; 0 if the attachment was skipped. */
  size: number;
  /** True if the attachment was skipped (e.g. exceeded MAX_ATTACHMENT_BYTES). */
  skipped: boolean;
}

/**
 * Save attachments under `<workspaceCwd>/<LOOP_ATTACHMENT_ROOT>/<loopRunId>/`.
 * Returns metadata for prompt rendering. Failures are logged and the
 * affected entry is marked skipped so we still emit a useful prompt.
 */
export async function saveLoopAttachments(
  workspaceCwd: string,
  loopRunId: string,
  attachments: LoopAttachment[],
): Promise<SavedAttachment[]> {
  const dir = join(workspaceCwd, LOOP_ATTACHMENT_ROOT, loopRunId);
  await mkdir(dir, { recursive: true });

  const filenames = dedupeFilenames(attachments.map((a) => a.name));
  const result: SavedAttachment[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const filename = filenames[i];
    const relativePath = `${LOOP_ATTACHMENT_ROOT}/${loopRunId}/${filename}`;
    const size = attachment.data.byteLength;

    if (size > MAX_ATTACHMENT_BYTES) {
      logger.warn('Skipping oversized loop attachment', { filename, size });
      result.push({ filename, relativePath, size: 0, skipped: true });
      continue;
    }

    try {
      await writeFile(join(dir, filename), attachment.data);
      result.push({ filename, relativePath, size, skipped: false });
    } catch (err) {
      logger.warn('Failed to write loop attachment', { filename, error: String(err) });
      result.push({ filename, relativePath, size: 0, skipped: true });
    }
  }

  return result;
}

/** Delete a loop's attachment folder. Best-effort; never throws. */
export async function cleanupLoopAttachments(workspaceCwd: string, loopRunId: string): Promise<void> {
  const dir = join(workspaceCwd, LOOP_ATTACHMENT_ROOT, loopRunId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Failed to cleanup loop attachments', { loopRunId, error: String(err) });
  }
}

/**
 * Build the path-reference block we prepend to the loop's prompt so each
 * iteration's CLI knows the attachments exist and where to find them.
 */
export function renderAttachmentBlock(saved: SavedAttachment[]): string {
  if (saved.length === 0) return '';
  const lines = ['Attached files (relative to workspace; use your file-read tools):'];
  for (const s of saved) {
    if (s.skipped) {
      lines.push(`- ${s.relativePath} (skipped: too large or unwritable)`);
    } else {
      lines.push(`- ${s.relativePath}`);
    }
  }
  return lines.join('\n');
}

/**
 * Append `LOOP_ATTACHMENT_ROOT/` to the workspace's .gitignore if it
 * isn't already covered. Best-effort; logs and continues on failure
 * so a read-only repo doesn't block loop start.
 */
export async function ensureLoopAttachmentsIgnored(workspaceCwd: string): Promise<void> {
  const gitignorePath = join(workspaceCwd, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    // No .gitignore yet — appendFile below will create one.
  }
  if (containsIgnore(existing, LOOP_ATTACHMENT_ROOT)) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const block = `${needsLeadingNewline ? '\n' : ''}# AI Orchestrator loop attachments\n${LOOP_ATTACHMENT_ROOT}/\n`;
  try {
    await appendFile(gitignorePath, block);
  } catch (err) {
    logger.warn('Failed to update .gitignore for loop attachments', { error: String(err) });
  }
}

/**
 * Check whether a .gitignore already covers the loop-attachment root.
 * Tolerates leading slash, trailing slash, and surrounding whitespace.
 */
export function containsIgnore(gitignoreContent: string, rootName: string): boolean {
  const lines = gitignoreContent.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.replace(/^\//, '').replace(/\/$/, '');
    if (normalized === rootName) return true;
  }
  return false;
}
