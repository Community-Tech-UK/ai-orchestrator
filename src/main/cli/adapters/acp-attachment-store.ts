/**
 * Durable copies of image attachments sent to ACP agents.
 *
 * An inline ACP image block is materialised by Copilot into
 * `$TMPDIR/acp-resource-<id>.<ext>`, recorded in the session transcript under
 * that path, and deleted when the ACP session closes. Hibernation closes the
 * session cleanly, so after a resume the transcript still points the model at
 * files that no longer exist and it cannot re-read or upload the user's
 * screenshots. When the image block's `uri` is a `file://` URL of an existing
 * file, Copilot references that file directly and never deletes it, so AIO
 * keeps its own copy under userData and hands the agent that path instead.
 *
 * Files are grouped by ACP session id (stable across resume), keyed by content
 * hash plus name so re-sending the same image is written once, and owner-only. They expire 30 days
 * after they were last sent, whether or not the session is still in use, so a
 * session resumed after that sees the original missing-file behaviour.
 *
 * Only POSIX paths are resolved by Copilot (see acp-attachment-blocks.ts); on
 * a Windows worker the file:// uri misses and Copilot falls back to its temp
 * copy, which is today's behaviour rather than a failure.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLogger } from '../../logging/logger';
import type { CliAttachment } from './base-cli-adapter.types';

const logger = getLogger('AcpAttachmentStore');

export const ACP_ATTACHMENT_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

let storeDirOverride: string | null = null;
let lastCleanupAt = 0;

export function setAcpAttachmentStoreDirForTesting(dir: string | null): void {
  storeDirOverride = dir;
  lastCleanupAt = 0;
}

function getUserDataPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    const userDataPath = app?.getPath?.('userData');
    if (typeof userDataPath === 'string' && userDataPath.length > 0) {
      return userDataPath;
    }
  } catch {
    // Electron not available (worker nodes, tests, headless)
  }
  return path.join(os.homedir(), '.orchestrator');
}

function getStoreDir(): string {
  return storeDirOverride ?? path.join(getUserDataPath(), 'acp-attachments');
}

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^\w.-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || fallback;
}

/** Keeps the user's filename but makes the extension match the bytes, so a
 *  renderer-compressed WebP named `shot.png` is not uploaded as a broken PNG. */
function storedFileName(name: string | undefined, mimeType: string): string {
  const base = sanitizeSegment(path.basename(name?.trim() || 'image'), 'image');
  const extension = IMAGE_EXTENSIONS[mimeType.toLowerCase()];
  if (!extension) {
    return base;
  }
  const stem = base.replace(/\.[^.]*$/, '') || 'image';
  return `${stem}.${extension}`;
}

function decodeInlineImage(content: string): Buffer {
  const commaIndex = content.startsWith('data:') ? content.indexOf(',') : -1;
  return Buffer.from(commaIndex === -1 ? content : content.slice(commaIndex + 1), 'base64');
}

function inlineImageMimeType(attachment: CliAttachment): string | undefined {
  const declared = attachment.mimeType?.trim();
  if (declared) {
    return declared;
  }
  return /^data:([^;,]+)/.exec(attachment.content ?? '')?.[1];
}

/**
 * Writes one inline image to the store and returns its absolute path, or null
 * when it cannot be persisted (the caller then keeps the inline-only block).
 */
export async function persistAcpImageAttachment(
  sessionId: string,
  attachment: CliAttachment,
): Promise<string | null> {
  const mimeType = inlineImageMimeType(attachment);
  if (!attachment.content || !mimeType?.startsWith('image/')) {
    return null;
  }
  try {
    const bytes = decodeInlineImage(attachment.content);
    if (bytes.length === 0) {
      return null;
    }
    const dir = path.join(getStoreDir(), sanitizeSegment(sessionId, 'session'));
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const filePath = path.join(dir, `${digest}-${storedFileName(attachment.name, mimeType)}`);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      // Same content already stored: refresh its age so the TTL counts from
      // the latest send rather than the first.
      const now = new Date();
      await fs.promises.utimes(filePath, now, now);
    } catch {
      // Write to a sibling then rename, so an agent reading the path never
      // observes a partially written file.
      const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.promises.writeFile(tempPath, bytes, { mode: 0o600 });
      await fs.promises.rename(tempPath, filePath);
    }
    maybeCleanupExpiredAttachments();
    return filePath;
  } catch (error) {
    logger.warn('Could not persist ACP image attachment; sending it inline only', {
      name: attachment.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Returns the attachments with a durable local `path` added to every inline
 * image, leaving other attachments (and images that fail to persist) as-is.
 */
export async function withPersistedAcpImageAttachments(
  sessionId: string,
  attachments: CliAttachment[] | undefined,
): Promise<CliAttachment[] | undefined> {
  if (!attachments?.length) {
    return attachments;
  }
  return Promise.all(attachments.map(async (attachment) => {
    if (attachment.path) {
      return attachment;
    }
    const storedPath = await persistAcpImageAttachment(sessionId, attachment);
    return storedPath ? { ...attachment, path: storedPath } : attachment;
  }));
}

function maybeCleanupExpiredAttachments(): void {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanupAt = now;
  runCleanup();
}

async function readDirSafe(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function cleanupExpiredAcpAttachments(
  maxAgeMs = ACP_ATTACHMENT_STORE_TTL_MS,
): Promise<number> {
  const root = getStoreDir();
  const now = Date.now();
  let deleted = 0;
  for (const sessionEntry of await readDirSafe(root)) {
    if (!sessionEntry.isDirectory()) {
      continue;
    }
    const sessionDir = path.join(root, sessionEntry.name);
    let deletedInSession = 0;
    for (const fileEntry of await readDirSafe(sessionDir)) {
      const filePath = path.join(sessionDir, fileEntry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.promises.unlink(filePath);
          deletedInSession += 1;
        }
      } catch {
        // Concurrent cleanup or already removed.
      }
    }
    deleted += deletedInSession;
    if (deletedInSession > 0) {
      try {
        // Only succeeds once the directory is empty. Directories this pass did
        // not empty are left alone so a send that just created one keeps it.
        await fs.promises.rmdir(sessionDir);
      } catch {
        // Still holds live attachments.
      }
    }
  }
  return deleted;
}

function runCleanup(): void {
  cleanupExpiredAcpAttachments().catch((error) => {
    logger.debug('ACP attachment store cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Sweeps once now, so an app restarted more often than hourly still expires
 *  old files, then hourly. */
export function initAcpAttachmentStoreCleanup(): NodeJS.Timeout {
  runCleanup();
  const handle = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  handle.unref();
  return handle;
}
