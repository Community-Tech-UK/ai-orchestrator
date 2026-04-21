export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const REMOTE_FETCH_TIMEOUT_MS = 10_000;
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const ALLOWED_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
] as const;
