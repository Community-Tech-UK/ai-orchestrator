/**
 * OpenCode session levers (A6.1-A6.3, Step 11a).
 *
 * Merged into `OPENCODE_CONFIG_CONTENT` before spawn:
 * - `agent.title.disable = true` always — Harness discards OpenCode's own
 *   title request (`session_info_update` titles are logged and dropped), so
 *   the title model call is pure waste.
 * - `agent.build.steps` / `agent.plan.steps` from the loop turn cap: 2.x
 *   enforces `steps` with a max-steps prompt and `toolChoice: "none"`. Task
 *   subagents keep their own budget, matching Claude's `--max-turns`, which
 *   caps the main loop only.
 * - `compaction.prune = true` on 1.x only (2.x dropped the setting as
 *   unsupported legacy).
 */

export interface OpenCodeSessionLeversOptions {
  /** OpenCode major version of the install that will be launched. */
  major: number;
  /** Loop turn cap, when the spawn carries one. */
  maxTurns?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/**
 * Merge the session levers into a parsed OpenCode config without dropping
 * other keys on the touched objects.
 */
export function applyOpenCodeSessionLevers(
  config: Record<string, unknown>,
  options: OpenCodeSessionLeversOptions,
): void {
  const agents = ensureRecord(config, 'agent');
  ensureRecord(agents, 'title')['disable'] = true;
  if (typeof options.maxTurns === 'number' && options.maxTurns > 0) {
    ensureRecord(agents, 'build')['steps'] = options.maxTurns;
    ensureRecord(agents, 'plan')['steps'] = options.maxTurns;
  }
  if (options.major < 2) {
    ensureRecord(config, 'compaction')['prune'] = true;
  }
}
