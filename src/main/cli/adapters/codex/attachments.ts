/** Codex inline image inputs only support a subset of image MIME types. */
const CODEX_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);

export function supportsCodexInlineImage(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  return CODEX_INLINE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}
