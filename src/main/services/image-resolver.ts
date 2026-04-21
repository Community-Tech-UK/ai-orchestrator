import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import DOMPurify from 'isomorphic-dompurify';
import type {
  ImageResolveRequest,
  ImageResolveResponse,
} from '@contracts/schemas/image';
import { ALLOWED_IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, REMOTE_FETCH_TIMEOUT_MS } from './image-constants';
import { getImageCache, type ImageCache } from './image-cache';
import { getLogger } from '../logging/logger';

const logger = getLogger('ImageResolver');

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

export interface ImageResolverOptions {
  cache?: ImageCache;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ImageResolver {
  private static instance: ImageResolver | null = null;

  private readonly cache: ImageCache;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  private constructor(options: ImageResolverOptions = {}) {
    this.cache = options.cache ?? getImageCache();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
  }

  static getInstance(options: ImageResolverOptions = {}): ImageResolver {
    if (!ImageResolver.instance) {
      ImageResolver.instance = new ImageResolver(options);
    }
    return ImageResolver.instance;
  }

  static _resetForTesting(): void {
    ImageResolver.instance = null;
  }

  async resolve(request: ImageResolveRequest): Promise<ImageResolveResponse> {
    try {
      switch (request.kind) {
        case 'local':
          return await this.resolveLocal(request.src, request.alt);
        case 'remote':
          return await this.resolveRemote(request.src, request.alt);
        case 'data':
          return this.resolveDataUri(request.src, request.alt);
      }
    } catch (error) {
      logger.error('Unexpected image resolution failure', error instanceof Error ? error : undefined, {
        kind: request.kind,
        src: request.src,
      });
      return {
        ok: false,
        reason: 'fetch_failed',
        message: 'Unexpected image resolution failure',
      };
    }
  }

  private async resolveLocal(src: string, alt?: string): Promise<ImageResolveResponse> {
    const resolvedPath = normalizeLocalPath(src);
    const extension = extensionFromSource(resolvedPath);

    if (!isAllowedImageExtension(extension)) {
      return {
        ok: false,
        reason: 'unsupported',
        message: 'Local file is not a supported image type',
      };
    }

    try {
      const buffer = await fs.readFile(resolvedPath);
      return this.buildSuccess(buffer, MIME_BY_EXTENSION[extension] ?? 'application/octet-stream', {
        src,
        alt,
        kind: 'local',
        fallbackName: path.basename(resolvedPath),
      });
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException)?.code;
      if (errorCode === 'ENOENT') {
        return { ok: false, reason: 'not_found', message: 'Local image file was not found' };
      }
      if (errorCode === 'EACCES' || errorCode === 'EPERM') {
        return { ok: false, reason: 'denied', message: 'Access to the local image file was denied' };
      }
      return { ok: false, reason: 'fetch_failed', message: 'Failed to read the local image file' };
    }
  }

  private async resolveRemote(src: string, alt?: string): Promise<ImageResolveResponse> {
    const cached = await this.cache.get(src);
    if (cached) {
      return this.buildSuccess(cached.buffer, cached.contentType, {
        src,
        alt,
        kind: 'remote',
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(src, {
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          reason: 'fetch_failed',
          message: `Remote image fetch failed with HTTP ${response.status}`,
        };
      }

      const headerContentType = normalizeContentType(response.headers.get('content-type'));
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
        return { ok: false, reason: 'too_large', message: 'Remote image exceeds the 10 MB limit' };
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const inferredContentType =
        headerContentType ??
        MIME_BY_EXTENSION[extensionFromSource(src)] ??
        'application/octet-stream';

      if (!inferredContentType.startsWith('image/')) {
        return {
          ok: false,
          reason: 'unsupported',
          message: 'Remote resource did not return an image content type',
        };
      }

      const resolved = await this.buildSuccess(buffer, inferredContentType, {
        src,
        alt,
        kind: 'remote',
      });

      if (resolved.ok) {
        await this.cache.set(src, inferredContentType, buffer);
      }

      return resolved;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return { ok: false, reason: 'timeout', message: 'Remote image fetch timed out' };
      }

      return { ok: false, reason: 'fetch_failed', message: 'Failed to fetch the remote image' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private resolveDataUri(src: string, alt?: string): ImageResolveResponse {
    const parsed = parseDataUri(src);
    if (!parsed || !parsed.contentType.startsWith('image/')) {
      return {
        ok: false,
        reason: 'invalid_data_uri',
        message: 'Invalid image data URI',
      };
    }

    return this.buildSuccess(parsed.buffer, parsed.contentType, {
      src,
      alt,
      kind: 'data',
    });
  }

  private buildSuccess(
    buffer: Buffer,
    contentType: string,
    options: {
      src: string;
      alt?: string;
      kind: 'local' | 'remote' | 'data';
      fallbackName?: string;
    },
  ): ImageResolveResponse {
    if (buffer.length > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'too_large', message: 'Image exceeds the 10 MB limit' };
    }

    let attachmentBuffer = buffer;
    let attachmentContentType = contentType;

    if (contentType === 'image/svg+xml') {
      const sanitizedSvg = DOMPurify.sanitize(buffer.toString('utf8'), {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject'],
      });

      attachmentBuffer = Buffer.from(sanitizedSvg, 'utf8');
      attachmentContentType = 'image/svg+xml';
    }

    return {
      ok: true,
      attachment: {
        name: buildAttachmentName(options.src, options.alt, attachmentContentType, options.fallbackName),
        type: attachmentContentType,
        size: attachmentBuffer.length,
        data: toDataUrl(attachmentContentType, attachmentBuffer),
      },
    };
  }
}

function normalizeLocalPath(src: string): string {
  if (src.startsWith('file://')) {
    return decodeURIComponent(new URL(src).pathname);
  }
  if (src.startsWith('~/')) {
    return path.join(os.homedir(), src.slice(2));
  }
  return src;
}

function extensionFromSource(src: string): string {
  try {
    if (/^https?:\/\//.test(src) || src.startsWith('file://')) {
      const url = new URL(src);
      return path.extname(url.pathname).toLowerCase();
    }
  } catch {
    // fall through to string-based parsing
  }

  return path.extname(src).toLowerCase();
}

function isAllowedImageExtension(extension: string): boolean {
  return ALLOWED_IMAGE_EXTENSIONS.includes(extension as (typeof ALLOWED_IMAGE_EXTENSIONS)[number]);
}

function normalizeContentType(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.split(';', 1)[0].trim().toLowerCase();
}

function parseDataUri(src: string): { contentType: string; buffer: Buffer } | null {
  if (!src.startsWith('data:')) {
    return null;
  }

  const commaIndex = src.indexOf(',');
  if (commaIndex < 0) {
    return null;
  }

  const header = src.slice(5, commaIndex);
  const payload = src.slice(commaIndex + 1);
  const [mimePart, ...params] = header.split(';');
  const contentType = mimePart.trim().toLowerCase();

  try {
    const normalizedPayload = payload.replace(/\s+/g, '');
    if (params.includes('base64')) {
      if (
        normalizedPayload.length === 0 ||
        normalizedPayload.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedPayload)
      ) {
        return null;
      }
      return {
        contentType,
        buffer: Buffer.from(normalizedPayload, 'base64'),
      };
    }

    const buffer = Buffer.from(decodeURIComponent(payload), 'utf8');
    return { contentType, buffer };
  } catch {
    return null;
  }
}

function buildAttachmentName(
  src: string,
  alt: string | undefined,
  contentType: string,
  fallbackName?: string,
): string {
  const sourceName = basenameFromSource(src) ?? fallbackName;
  const preferredBase = sanitizeName(sourceName ?? alt ?? 'inline-image');
  const extension = extensionForContentType(contentType);

  if (preferredBase.toLowerCase().endsWith(extension)) {
    return preferredBase;
  }
  return `${preferredBase}${extension}`;
}

function basenameFromSource(src: string): string | null {
  if (src.startsWith('data:')) {
    return null;
  }
  try {
    if (/^https?:\/\//.test(src) || src.startsWith('file://')) {
      const url = new URL(src);
      const name = path.basename(url.pathname);
      return name || null;
    }
  } catch {
    // fall through
  }
  if (src.startsWith('~/') || src.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(src)) {
    return path.basename(src);
  }
  return null;
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'inline-image';
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
}

function extensionForContentType(contentType: string): string {
  return (
    Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === contentType)?.[0] ??
    '.img'
  );
}

function toDataUrl(contentType: string, buffer: Buffer): string {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

export function getImageResolver(): ImageResolver {
  return ImageResolver.getInstance();
}
