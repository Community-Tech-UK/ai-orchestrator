import { FILE_LIMITS } from './instance.types';

export interface InstanceAttachment {
  name: string;
  type: string;
  size: number;
  data: string;
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2000;

export function validateFiles(files: File[]): string[] {
  const errors: string[] = [];

  if (files.length > FILE_LIMITS.MAX_ATTACHMENTS) {
    errors.push(
      `Too many attachments (${files.length}). A message can carry at most ` +
        `${FILE_LIMITS.MAX_ATTACHMENTS}. Remove some and send the rest separately.`,
    );
  }

  for (const file of files) {
    // Images are deliberately NOT size-checked here. `fileToAttachments`
    // compresses them, and any image past `MAX_IMAGE_DIMENSION` is tiled
    // without consulting `file.size` at all — so a 25MB high-resolution
    // screenshot encodes fine today. A size gate here would reject staged sets
    // that currently work. An image that genuinely cannot be encoded throws
    // from `fileToAttachments`, which is now surfaced as a typed failure with
    // the composition intact.
    if (!file.type.startsWith('image/') && file.size > MAX_FILE_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      errors.push(`${file.name} is too large (${sizeMB}MB). Maximum size is 30MB.`);
    }
  }

  return errors;
}

/**
 * Post-expansion attachment-count check.
 *
 * `fileToAttachments` tiles any image whose longest edge exceeds
 * `MAX_IMAGE_DIMENSION`, so N staged files can become more than N attachments.
 * The main process caps the array at `FILE_LIMITS.MAX_ATTACHMENTS` and rejects
 * the entire payload past that — silently, because Zod failures are not logged
 * on the create path. Callers must run this on the *produced* attachments,
 * before the IPC call, so the user gets a real message instead of nothing.
 */
export function validateAttachmentCount(attachments: InstanceAttachment[], stagedFileCount: number): string | null {
  if (attachments.length <= FILE_LIMITS.MAX_ATTACHMENTS) {
    return null;
  }

  const expanded = attachments.length > stagedFileCount;
  return (
    `Too many attachments (${attachments.length}, limit ${FILE_LIMITS.MAX_ATTACHMENTS}).` +
    (expanded
      ? ` ${stagedFileCount} file(s) expanded to ${attachments.length} because large images are` +
        ` split into tiles. Remove some images or crop them below ${MAX_IMAGE_DIMENSION}px.`
      : ' Remove some and send the rest separately.')
  );
}

/** Converts a HEIC/HEIF photo, which Chromium cannot decode, into a JPEG `File`. */
export type HeicConverter = (file: File) => Promise<File>;

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

/** iPhone photos arrive as HEIC; a file loaded from a path may carry no MIME type, so the extension counts too. */
export function isHeicFile(file: File): boolean {
  return HEIC_MIME_TYPES.has(file.type.toLowerCase()) || /\.hei[cf]$/i.test(file.name);
}

/** A staged file that could not be converted or read. Show `visibleMessage`; the reason stays the cause for logs. */
export class StagedFileError extends Error {
  readonly visibleMessage: string;

  constructor(file: File, cause: unknown) {
    super(`Could not prepare attachment ${file.name}`, { cause });
    this.name = 'StagedFileError';
    this.visibleMessage = isHeicFile(file)
      ? `${file.name} could not be converted. Save it as JPEG or PNG and attach that instead.`
      : `${file.name} could not be read. Check the file still exists, then attach it again.`;
  }
}

/**
 * Reads staged files for saving as they are (loop and automation attachments), converting HEIC photos first,
 * since agents cannot open them either. Rejects with a `StagedFileError` naming the first file that failed.
 */
export function readStagedFiles<T>(
  files: readonly File[],
  convertHeic: HeicConverter,
  read: (file: File) => Promise<T>,
): Promise<T[]> {
  return Promise.all(files.map(async (staged) => {
    try {
      return await read(isHeicFile(staged) ? await convertHeic(staged) : staged);
    } catch (error) {
      throw new StagedFileError(staged, error);
    }
  }));
}

export async function fileToAttachments(input: File, convertHeic: HeicConverter): Promise<InstanceAttachment[]> {
  const file = isHeicFile(input) ? await convertHeic(input) : input;
  const isImage = file.type.startsWith('image/');

  if (!isImage) {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File ${file.name} exceeds maximum size of 30MB`);
    }
    const data = await fileToDataURL(file);
    return [{ name: file.name, type: file.type, size: file.size, data }];
  }

  const dimensions = await getImageDimensions(file);
  if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
    return tileOversizedImage(file, dimensions);
  }

  let processedFile = file;
  if (file.size > MAX_IMAGE_SIZE) {
    processedFile = await tryCompressImage(file);
  }

  if (processedFile.size > MAX_IMAGE_SIZE) {
    throw new Error(`File ${file.name} exceeds maximum size of 5MB`);
  }

  const data = await fileToDataURL(processedFile);
  return [{ name: processedFile.name, type: processedFile.type, size: processedFile.size, data }];
}

async function tryCompressImage(file: File): Promise<File> {
  const qualities = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

  for (const quality of qualities) {
    const compressed = await compressImage(file, quality);
    if (compressed && compressed.size <= MAX_IMAGE_SIZE) {
      const newFileName = file.name.replace(/\.[^.]+$/, '.webp');
      return new File([compressed], newFileName, { type: 'image/webp' });
    }
  }

  return file;
}

function compressImage(file: File, quality = 0.85): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (event) => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          const ratio = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
          width = Math.floor(width * ratio);
          height = Math.floor(height * ratio);
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(blob), 'image/webp', quality);
      };

      img.onerror = () => resolve(null);
      img.src = event.target?.result as string;
    };

    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load image ${file.name}`));
    };
    img.src = url;
  });
}

async function tileOversizedImage(
  file: File,
  dimensions: { width: number; height: number },
): Promise<InstanceAttachment[]> {
  const img = await loadImage(file);
  let drawWidth = dimensions.width;
  let drawHeight = dimensions.height;
  if (drawWidth > MAX_IMAGE_DIMENSION) {
    const ratio = MAX_IMAGE_DIMENSION / drawWidth;
    drawWidth = MAX_IMAGE_DIMENSION;
    drawHeight = Math.floor(dimensions.height * ratio);
  }

  const tileHeight = MAX_IMAGE_DIMENSION;
  const tileCount = Math.ceil(drawHeight / tileHeight);
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const attachments: InstanceAttachment[] = [];

  for (let i = 0; i < tileCount; i++) {
    const srcY = Math.floor((i * tileHeight / drawHeight) * dimensions.height);
    const nextY = Math.floor(((i + 1) * tileHeight / drawHeight) * dimensions.height);
    const srcH = Math.min(nextY, dimensions.height) - srcY;
    const destH = Math.min(tileHeight, drawHeight - i * tileHeight);
    const canvas = document.createElement('canvas');
    canvas.width = drawWidth;
    canvas.height = destH;

    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.drawImage(img, 0, srcY, dimensions.width, srcH, 0, 0, drawWidth, destH);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((value) => resolve(value), 'image/webp', 0.92),
    );
    if (!blob) continue;

    const tileName = `${baseName}_tile${i + 1}of${tileCount}.webp`;
    const tileFile = new File([blob], tileName, { type: 'image/webp' });
    const data = await fileToDataURL(tileFile);
    attachments.push({ name: tileName, type: 'image/webp', size: tileFile.size, data });
  }

  return attachments;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load image ${file.name}`));
    };
    img.src = url;
  });
}
