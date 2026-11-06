import { createHash } from 'node:crypto';

/** Content version, not an authorization token. No retained snapshots or caller state. */
export function versionedToolStatus(result: unknown, sinceVersion?: string): unknown {
  const version = createHash('sha256').update(JSON.stringify(result) ?? 'null').digest('hex');
  if (version === sinceVersion) return { unchanged: true, version };
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { version, ...result }
    : { version, status: result };
}
