/**
 * Helpers for attaching the `chrome-devtools` MCP server to an Harness-managed
 * Chrome profile via its CDP remote-debugging endpoint.
 *
 * The attach contract requires the managed profile's debug port to be **stable
 * and known at agent spawn time** — chrome-devtools-mcp is configured with
 * `--browserUrl http://127.0.0.1:<port>` when the agent is spawned, before any
 * managed Chrome is running (chrome-devtools-mcp connects lazily on first tool
 * use). To avoid persisting per-profile port assignments (and a DB migration),
 * the port is **derived deterministically** from the profile id so the spawn-time
 * URL and the launch-time `--remote-debugging-port` always match.
 *
 * Only profiles with chrome-devtools attach enabled use this derived port; all
 * other managed profiles keep random port allocation. If the derived port is
 * already bound at launch, the launcher hard-fails with a clear error rather than
 * silently drifting to a different port (which would invalidate the spawn-time
 * URL).
 */

/** Localhost host used for the managed CDP endpoint. */
export const MANAGED_DEBUG_HOST = '127.0.0.1';

/**
 * Port band for derived managed-profile debug ports. Chosen to sit above the
 * common service range and below the typical OS ephemeral range (which on macOS
 * starts at 49152) to reduce the chance of colliding with transient sockets.
 */
const DERIVED_PORT_MIN = 10_000;
const DERIVED_PORT_RANGE = 40_000; // → [10000, 49999]

/** 32-bit FNV-1a hash. Deterministic, dependency-free, stable across processes. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Math.imul keeps the multiply within 32-bit signed range.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically derive a stable CDP debug port for a managed profile.
 * The same `profileId` always yields the same port, in [10000, 49999].
 */
export function deriveManagedDebugPort(profileId: string): number {
  if (!profileId) {
    throw new Error('deriveManagedDebugPort requires a non-empty profileId');
  }
  return DERIVED_PORT_MIN + (fnv1a(profileId) % DERIVED_PORT_RANGE);
}

/**
 * Build the `--browserUrl` value chrome-devtools-mcp uses to attach to the
 * managed profile's CDP endpoint.
 */
export function resolveChromeDevtoolsBrowserUrl(profileId: string): string {
  return `http://${MANAGED_DEBUG_HOST}:${deriveManagedDebugPort(profileId)}`;
}
