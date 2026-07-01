const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Small deterministic digest for cache keys and log correlation only.
 * This is not cryptographic and must not be used for secrets or trust checks.
 */
export function shortHash(input: string): string {
  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
