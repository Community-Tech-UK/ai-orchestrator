/**
 * Convert a Blob into a data URL Electron's nativeImage can ingest.
 *
 * Electron's nativeImage.createFromDataURL supports PNG and JPEG reliably. Any
 * other image MIME is re-encoded via canvas before being sent over IPC.
 */
export async function blobToClipboardCompatibleDataUrl(blob: Blob): Promise<string | null> {
  const dataUrl = await blobToDataUrl(blob);
  if (!dataUrl) {
    return null;
  }
  return dataUrlToClipboardCompatibleDataUrl(dataUrl);
}

export function dataUrlToClipboardCompatibleDataUrl(dataUrl: string): Promise<string | null> {
  const header = dataUrl.slice(0, 32).toLowerCase();
  if (header.startsWith('data:image/png') || header.startsWith('data:image/jpeg')) {
    return Promise.resolve(dataUrl);
  }

  return new Promise((resolve) => {
    const img = new Image();
    const timeout = window.setTimeout(() => resolve(null), 1000);
    const finish = (value: string | null): void => {
      window.clearTimeout(timeout);
      resolve(value);
    };
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) {
        finish(null);
        return;
      }
      ctx.drawImage(img, 0, 0);
      try {
        finish(canvas.toDataURL('image/png'));
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
