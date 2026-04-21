import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { app } from 'electron';
import { CACHE_MAX_BYTES } from './image-constants';
import { getLogger } from '../logging/logger';

const logger = getLogger('ImageCache');

interface ImageCacheIndexEntry {
  contentHash: string;
  contentType: string;
  size: number;
  updatedAt: number;
}

interface ImageCacheIndexFile {
  entries: Record<string, ImageCacheIndexEntry>;
}

export interface CachedImage {
  buffer: Buffer;
  contentType: string;
  size: number;
  updatedAt: number;
}

export interface ImageCacheOptions {
  cacheDir?: string;
  maxBytes?: number;
  now?: () => number;
}

export class ImageCache {
  private static instance: ImageCache | null = null;

  private readonly cacheDir: string;
  private readonly objectsDir: string;
  private readonly indexPath: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private index: Record<string, ImageCacheIndexEntry> | null = null;

  private constructor(options: ImageCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? path.join(app.getPath('userData'), 'image-cache');
    this.objectsDir = path.join(this.cacheDir, 'objects');
    this.indexPath = path.join(this.cacheDir, 'index.json');
    this.maxBytes = options.maxBytes ?? CACHE_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  static getInstance(options: ImageCacheOptions = {}): ImageCache {
    if (!ImageCache.instance) {
      ImageCache.instance = new ImageCache(options);
    }
    return ImageCache.instance;
  }

  static _resetForTesting(): void {
    ImageCache.instance = null;
  }

  async get(url: string): Promise<CachedImage | null> {
    const index = await this.loadIndex();
    const entry = index[hashString(url)];
    if (!entry) {
      return null;
    }

    try {
      const buffer = await fs.readFile(this.objectPath(entry.contentHash));
      entry.updatedAt = this.now();
      await this.persistIndex(index);
      return {
        buffer,
        contentType: entry.contentType,
        size: entry.size,
        updatedAt: entry.updatedAt,
      };
    } catch (error) {
      logger.warn('Failed to read cached image object; evicting index entry', {
        url,
        error: String(error),
      });
      delete index[hashString(url)];
      await this.persistIndex(index);
      return null;
    }
  }

  async set(url: string, contentType: string, buffer: Buffer): Promise<void> {
    const index = await this.loadIndex();
    const contentHash = hashBuffer(buffer);
    const objectPath = this.objectPath(contentHash);

    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    try {
      await fs.access(objectPath);
    } catch {
      await fs.writeFile(objectPath, buffer);
    }

    index[hashString(url)] = {
      contentHash,
      contentType,
      size: buffer.length,
      updatedAt: this.now(),
    };

    await this.persistIndex(index);
    await this.enforceMaxSize(index);
  }

  private async loadIndex(): Promise<Record<string, ImageCacheIndexEntry>> {
    if (this.index !== null) {
      return this.index;
    }

    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as ImageCacheIndexFile;
      this.index = parsed.entries ?? {};
    } catch {
      this.index = {};
    }

    return this.index;
  }

  private async persistIndex(index: Record<string, ImageCacheIndexEntry>): Promise<void> {
    this.index = index;
    await fs.mkdir(this.cacheDir, { recursive: true });
    const tmpPath = `${this.indexPath}.tmp`;
    const payload: ImageCacheIndexFile = { entries: index };
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmpPath, this.indexPath);
  }

  private async enforceMaxSize(index: Record<string, ImageCacheIndexEntry>): Promise<void> {
    const refCounts = new Map<string, number>();
    const sizes = new Map<string, number>();

    for (const entry of Object.values(index)) {
      refCounts.set(entry.contentHash, (refCounts.get(entry.contentHash) ?? 0) + 1);
      sizes.set(entry.contentHash, entry.size);
    }

    let totalBytes = 0;
    for (const size of sizes.values()) {
      totalBytes += size;
    }

    if (totalBytes <= this.maxBytes) {
      return;
    }

    const evictionOrder = Object.entries(index).sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt,
    );

    for (const [urlHash, entry] of evictionOrder) {
      delete index[urlHash];
      const remainingRefs = (refCounts.get(entry.contentHash) ?? 1) - 1;
      if (remainingRefs <= 0) {
        refCounts.delete(entry.contentHash);
        totalBytes -= sizes.get(entry.contentHash) ?? 0;
        sizes.delete(entry.contentHash);
        try {
          await fs.unlink(this.objectPath(entry.contentHash));
        } catch {
          // best-effort eviction
        }
      } else {
        refCounts.set(entry.contentHash, remainingRefs);
      }

      if (totalBytes <= this.maxBytes) {
        break;
      }
    }

    await this.persistIndex(index);
  }

  private objectPath(contentHash: string): string {
    return path.join(this.objectsDir, contentHash.slice(0, 2), `${contentHash}.bin`);
  }
}

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashBuffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function getImageCache(): ImageCache {
  return ImageCache.getInstance();
}
