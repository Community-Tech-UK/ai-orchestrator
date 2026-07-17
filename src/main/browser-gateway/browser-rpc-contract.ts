/**
 * Browser Gateway host↔bridge RPC contract identity.
 *
 * Imported by BOTH the main-process RPC server and the MCP forwarder bundled
 * into the aio-mcp SEA, so this module MUST stay dependency-free — no
 * electron, no main-process singletons (same rule as browser-mutation-safety).
 *
 * Why this exists: the bridge binary and the running app are built separately,
 * so their tool schemas can skew. The protocol version + tool-surface hash let
 * each side detect skew (`browser.report_tool_surface`, `browser.health`)
 * instead of failing opaquely with `invalid_browser_gateway_rpc_payload`.
 */

import { createHash } from 'node:crypto';

/**
 * Bump on any BREAKING change to the RPC methods/payload semantics. Additive
 * optional fields do NOT bump this — the server strips unknown optional fields
 * from newer clients and records a `schema_skew_stripped` event instead.
 */
export const BROWSER_GATEWAY_RPC_PROTOCOL_VERSION = 1;

export interface BrowserToolSurfaceEntry {
  name: string;
  inputSchema: unknown;
}

/**
 * Deterministic fingerprint of an MCP tool surface (names + input schemas,
 * order-independent). Equal hashes ⇒ byte-identical advertised capability.
 */
export function computeBrowserToolSurfaceHash(
  tools: readonly BrowserToolSurfaceEntry[],
): string {
  const canonical = [...tools]
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}
