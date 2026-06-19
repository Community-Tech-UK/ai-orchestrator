/**
 * Shared classification of Browser Gateway operations by retry-safety and cost.
 *
 * Imported by BOTH the worker-side RPC client (bundled into the aio-mcp SEA) and
 * the main-process gateway service, so this module MUST stay dependency-free —
 * no electron, no node-only side effects — only strings and regular expressions.
 *
 * Why this exists: a tool call that times out may have ALREADY mutated the page
 * server-side before its acknowledgement was lost. Blindly retrying a
 * non-idempotent op (a click that added a section, a `type` that appended text,
 * a builder insert) then duplicates the effect — the exact failure mode that
 * produced 2-3x duplicated sections in the Webflow Designer incident
 * (docs/webflow-mcp-designer-throttling.md). Reads/snapshots are harmless to
 * retry; mutations are not and must be surfaced as "maybe applied" so the caller
 * verifies state before re-issuing the call.
 */

// Page/browser-state-mutating commands (bare command names, as used by the
// extension command store) that are NOT safe to blind-retry on timeout. We err
// toward over-inclusion: a false positive only costs a verify-before-retry hint,
// while a false negative invites a duplicate mutation.
const MUTATING_BROWSER_COMMANDS: ReadonlySet<string> = new Set([
  'open_tab',
  'find_or_open',
  'navigate',
  'click',
  'type',
  'fill_form',
  'select',
  'upload_file',
  'download_file',
  // Arbitrary JS — may perform any mutation, so it is never safe to blind-retry.
  'evaluate',
]);

// Defense-in-depth for builder-style command names from third-party designer MCP
// bridges (Webflow's *_builder / create_* / insert_* / add_*, etc.) in case such
// commands are ever proxied through the gateway. These are inherently
// non-idempotent document mutations.
const MUTATING_BROWSER_NAME_PATTERN =
  /(?:_builder$)|^(?:create|insert|add|append|remove|delete|update|set|move|duplicate|paste)_/;

// Read operations whose cost scales with DOM size. On a large/complex page these
// legitimately take far longer than a snappy navigation, so a single short
// global timeout reports them as false timeouts. `evaluate` is included because
// arbitrary JS can also be expensive (it is additionally treated as mutating).
const HEAVY_DOM_BROWSER_COMMANDS: ReadonlySet<string> = new Set([
  'snapshot',
  'accessibility_snapshot',
  'query_elements',
  'screenshot',
  'evaluate',
]);

/**
 * Execution budget (ms) for DOM-scaling ops on the extension path. Larger than
 * the 30s default so a heavy snapshot/query on a big page completes instead of
 * surfacing a misleading command timeout.
 */
export const HEAVY_DOM_COMMAND_TIMEOUT_MS = 60_000;

/** Strip an optional `browser.` (or any dotted) namespace from a method id. */
function bareCommandName(methodOrCommand: string): string {
  const dot = methodOrCommand.lastIndexOf('.');
  return (dot === -1 ? methodOrCommand : methodOrCommand.slice(dot + 1)).toLowerCase();
}

/** True for bare command names that mutate page/browser state (e.g. `click`). */
export function isMutatingBrowserCommand(command: string): boolean {
  const name = bareCommandName(command);
  return MUTATING_BROWSER_COMMANDS.has(name) || MUTATING_BROWSER_NAME_PATTERN.test(name);
}

/** True for namespaced method ids that mutate state (e.g. `browser.click`). */
export function isMutatingBrowserMethod(method: string): boolean {
  return isMutatingBrowserCommand(method);
}

/** True for bare command names whose cost scales with DOM size. */
export function isHeavyDomBrowserCommand(command: string): boolean {
  return HEAVY_DOM_BROWSER_COMMANDS.has(bareCommandName(command));
}

/** True for namespaced method ids whose cost scales with DOM size. */
export function isHeavyDomBrowserMethod(method: string): boolean {
  return isHeavyDomBrowserCommand(method);
}
