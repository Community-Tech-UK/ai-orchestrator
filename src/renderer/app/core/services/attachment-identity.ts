/** Identity for files waiting in one composer. Hash small files at ingress. */
const FINGERPRINT_MAX_BYTES = 8 * 1024 * 1024;
const fingerprints = new WeakMap<File, string>();

function readBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export async function fingerprintFile(file: File): Promise<string | null> {
  const cached = fingerprints.get(file);
  if (cached !== undefined) return cached;
  if (file.size > FINGERPRINT_MAX_BYTES) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readBytes(file));
  } catch {
    return null;
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 0x01000193);
    h2 = Math.imul(h2 ^ byte, 0x85ebca6b);
  }
  // Keep the integer within JavaScript's exact 53-bit range.
  const hash = ((h1 >>> 0) * 0x20_0000 + ((h2 >>> 0) & 0x1f_ffff)).toString(36);
  fingerprints.set(file, hash);
  return hash;
}

export function identityOf(file: File): string | File {
  const fingerprint = fingerprints.get(file);
  if (fingerprint !== undefined) return `fp:${fingerprint}`;
  // Matching metadata cannot prove matching contents. Keep distinct files
  // when hashing was skipped or failed, but still recognize the same object.
  return file;
}

export interface SplitNewAttachments {
  added: File[];
  skipped: number;
}

export function splitNewAttachments(existing: readonly File[], incoming: readonly File[]): SplitNewAttachments {
  const seen = new Set(existing.map(identityOf));
  const added: File[] = [];
  let skipped = 0;
  for (const file of incoming) {
    const identity = identityOf(file);
    if (seen.has(identity)) {
      skipped++;
      continue;
    }
    seen.add(identity);
    added.push(file);
  }
  return { added, skipped };
}

export function notifySkippedAttachments(
  toast: { show(text: string, type?: 'success' | 'error'): void },
  count: number,
): void {
  if (count > 0) toast.show('Already attached.');
}
