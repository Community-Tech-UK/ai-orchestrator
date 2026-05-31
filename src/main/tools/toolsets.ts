/**
 * Toolset registry (claude2_todo #19).
 *
 * A single primitive — a named `{ tools, includes }` bundle with a recursive
 * resolver — that expresses semantic tool groups, composite scenarios,
 * per-surface scoping (one toolset per channel / agent role), and a security
 * boundary (e.g. a tiny read-only subset that resists prompt-injection from
 * untrusted webhook/PR content). The same resolver also supports the
 * deny-all-then-allow `['*', '!x']` grammar from #18(c).
 *
 * Entry grammar (order-sensitive, applied left to right after `includes`):
 *   - `"toolId"`   — add a concrete tool
 *   - `"*"`        — add every known tool (requires `allTools` in the context)
 *   - `"!toolId"`  — remove a tool (exact match)
 *   - `"!glob*"`   — remove tools matching a `*` wildcard / `name__`/`name:` prefix
 *
 * A per-tool runtime `isAvailable` check (the "check_fn") drops tools whose
 * dependency (a CDP endpoint, a credential, a reachable MCP server) is missing,
 * so they silently disappear from the model-facing list instead of erroring on
 * call. Caching of that check is the caller's responsibility.
 *
 * Pure (no I/O); the registry is an in-memory map. Cycle-safe.
 */

export interface ToolsetDefinition {
  name: string;
  /** Tool entries (see grammar above). Defaults to `[]`. */
  tools?: string[];
  /** Names of other toolsets to compose first (recursive). Defaults to `[]`. */
  includes?: string[];
  description?: string;
}

export interface ToolsetResolveContext {
  /** Universe of all known tool ids — required to expand a `"*"` entry. */
  allTools?: string[];
  /**
   * Optional per-tool availability predicate ("check_fn"). Tools for which this
   * returns false are dropped from the resolved list. Caching is the caller's
   * concern.
   */
  isAvailable?: (toolId: string) => boolean;
}

/** Match a tool id against a pattern: exact, namespaced-prefix, or `*` glob. */
function matchPattern(toolId: string, pattern: string): boolean {
  if (toolId === pattern) return true;
  if (toolId.startsWith(`${pattern}__`) || toolId.startsWith(`${pattern}:`)) return true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(toolId);
  }
  return false;
}

export class ToolsetRegistry {
  private readonly defs = new Map<string, ToolsetDefinition>();

  /** Register (or replace) a toolset definition. */
  register(def: ToolsetDefinition): this {
    if (!def.name) throw new Error('Toolset definition requires a name');
    this.defs.set(def.name, def);
    return this;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  get(name: string): ToolsetDefinition | undefined {
    return this.defs.get(name);
  }

  list(): string[] {
    return [...this.defs.keys()];
  }

  /**
   * Resolve a registered toolset to a concrete, de-duplicated,
   * availability-filtered, order-preserving list of tool ids.
   * Throws if `name` is not registered.
   */
  resolve(name: string, ctx: ToolsetResolveContext = {}): string[] {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Unknown toolset: ${name}`);
    return this.resolveDefinition(def, ctx);
  }

  /**
   * Resolve an ad-hoc definition (not necessarily registered). Its `includes`
   * are still resolved against the registry.
   */
  resolveDefinition(def: ToolsetDefinition, ctx: ToolsetResolveContext = {}): string[] {
    const resolved = this.expand(def, ctx, new Set<string>());
    if (!ctx.isAvailable) return resolved;
    return resolved.filter((tool) => ctx.isAvailable!(tool));
  }

  /** Recursive expansion with cycle detection; returns ordered unique ids. */
  private expand(
    def: ToolsetDefinition,
    ctx: ToolsetResolveContext,
    visiting: Set<string>,
  ): string[] {
    if (def.name) {
      if (visiting.has(def.name)) return []; // cycle — already being expanded
      visiting.add(def.name);
    }

    // Use an ordered set: array for order + Set for membership.
    const order: string[] = [];
    const present = new Set<string>();
    const add = (tool: string) => {
      if (!present.has(tool)) {
        present.add(tool);
        order.push(tool);
      }
    };
    const remove = (pattern: string) => {
      for (let i = order.length - 1; i >= 0; i--) {
        if (matchPattern(order[i]!, pattern)) {
          present.delete(order[i]!);
          order.splice(i, 1);
        }
      }
    };

    // 1. Includes first (recursive).
    for (const include of def.includes ?? []) {
      const sub = this.defs.get(include);
      if (!sub) {
        throw new Error(`Toolset "${def.name}" includes unknown toolset "${include}"`);
      }
      for (const tool of this.expand(sub, ctx, visiting)) add(tool);
    }

    // 2. Own entries, applied in order (so a later "!x" can drop an earlier add).
    for (const entry of def.tools ?? []) {
      if (entry === '*') {
        for (const tool of ctx.allTools ?? []) add(tool);
      } else if (entry.startsWith('!')) {
        remove(entry.slice(1));
      } else {
        add(entry);
      }
    }

    if (def.name) visiting.delete(def.name);
    return order;
  }
}

/** Convenience factory pre-loaded with the given definitions. */
export function createToolsetRegistry(defs: ToolsetDefinition[] = []): ToolsetRegistry {
  const registry = new ToolsetRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}
