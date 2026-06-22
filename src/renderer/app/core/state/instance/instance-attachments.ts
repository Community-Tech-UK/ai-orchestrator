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
  for (const file of files) {
    const isImage = file.type.startsWith('image/');
    const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
    const maxSizeMB = isImage ? 5 : 30;
    if (!isImage && file.size > maxSize) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      errors.push(`${file.name} is too large (${sizeMB}MB). Maximum size is ${maxSizeMB}MB.`);
    }
  }
  return errors;
}

export async function fileToAttachments(file: File): Promise<InstanceAttachment[]> {
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
