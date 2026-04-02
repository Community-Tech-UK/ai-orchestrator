/**
 * Content Store
 *
 * Hybrid inline/external storage for session snapshot content fields.
 *
 * Routing rule:
 *   < 1 KB  → inline in JSON as { inline: true, content }
 *   >= 1 KB → external file as { inline: false, hash, size }
 *
 * External files are stored at:
 *   <userData>/content-store/<first-2-hash-chars>/<full-sha256-hash>
 *
 * SHA-256 hashing provides content-addressed deduplication.
 * Write path is fire-and-forget: store() does NOT await the disk write.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('ContentStore');

export const INLINE_THRESHOLD_BYTES = 1024; // 1 KB

export type ContentRef =
  | { inline: true; content: string }
  | { inline: false; hash: string; size: number };

export class ContentIntegrityError extends Error {
  constructor(expectedHash: string, actualHash: string) {
    super(
      `Content integrity check failed: expected hash ${expectedHash}, got ${actualHash}`
    );
    this.name = 'ContentIntegrityError';
  }
}

export class ContentStore {
  private static instance: ContentStore | null = null;

  private storeDir: string;

  private constructor() {
    this.storeDir = path.join(app.getPath('userData'), 'content-store');
  }

  static getInstance(): ContentStore {
    if (!ContentStore.instance) {
      ContentStore.instance = new ContentStore();
    }
    return ContentStore.instance;
  }

  static _resetForTesting(): void {
    ContentStore.instance = null;
  }

  /**
   * Store content and return a ContentRef.
   * For small content (< INLINE_THRESHOLD_BYTES) no disk I/O occurs.
   * For large content the disk write is fire-and-forget.
   */
  async store(content: string): Promise<ContentRef> {
    const bytes = Buffer.byteLength(content, 'utf8');

    if (bytes < INLINE_THRESHOLD_BYTES) {
      return { inline: true, content };
    }

    const hash = sha256(content);
    const filePath = this.externalPath(hash);

    // Fire-and-forget — do not await
    fs.mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.writeFile(filePath, content, 'utf8'))
      .catch((err: unknown) => {
        logger.error('Failed to write external content', err as Error, { hash });
      });

    return { inline: false, hash, size: bytes };
  }

  /**
   * Resolve a ContentRef back to its string content.
   * Throws ContentIntegrityError if the retrieved content does not match
   * the expected hash (external refs only).
   */
  async resolve(ref: ContentRef): Promise<string> {
    if (ref.inline) {
      return ref.content;
    }

    const filePath = this.externalPath(ref.hash);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      logger.error('Failed to read external content', err as Error, { hash: ref.hash });
      throw err;
    }

    const actualHash = sha256(content);
    if (actualHash !== ref.hash) {
      throw new ContentIntegrityError(ref.hash, actualHash);
    }

    return content;
  }

  /**
   * Remove external content files older than maxAgeDays.
   * Walks the two-level sharded directory structure.
   */
  async cleanup(maxAgeDays: number): Promise<void> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    let shards: string[];
    try {
      shards = await fs.readdir(this.storeDir);
    } catch {
      return;
    }

    for (const shard of shards) {
      const shardPath = path.join(this.storeDir, shard);
      try {
        const shardStat = await fs.stat(shardPath);
        if (!shardStat.isDirectory()) continue;

        const files = await fs.readdir(shardPath);
        for (const file of files) {
          const filePath = path.join(shardPath, file);
          try {
            const fileStat = await fs.stat(filePath);
            if (fileStat.mtime.getTime() < cutoff) {
              await fs.unlink(filePath);
              logger.debug('Removed stale content store file', { file });
            }
          } catch (err) {
            logger.warn('Could not process content store file during cleanup', { filePath, err });
          }
        }
      } catch (err) {
        logger.warn('Could not process content store shard during cleanup', { shard, err });
      }
    }
  }

  private externalPath(hash: string): string {
    return path.join(this.storeDir, hash.slice(0, 2), hash);
  }
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function getContentStore(): ContentStore {
  return ContentStore.getInstance();
}
