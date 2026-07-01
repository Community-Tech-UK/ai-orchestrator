/**
 * Plugin entrypoint classification + de-duplication (Task 17).
 *
 * Pure helpers, split out of `plugin-manager.ts` so the entrypoint rules stay
 * small and independently testable.
 */
import * as path from 'path';

/** How a plugin entrypoint is loaded, derived from its file extension. */
export type PluginEntrypointKind = 'javascript' | 'typescript';

/**
 * Classify a plugin entrypoint by extension. TypeScript entrypoints (`.ts`,
 * `.mts`, `.cts`) can only be loaded in worker isolation (where tsx is
 * registered); everything else is treated as JavaScript.
 */
export function classifyPluginEntrypoint(filePath: string): PluginEntrypointKind {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')
    ? 'typescript'
    : 'javascript';
}

/**
 * When a plugin directory ships both a compiled `<name>.js` and its `<name>.ts`
 * source (common in dev), load only ONE of them — prefer the `.js` so we never
 * double-register the same plugin. Keyed by directory + basename-without-ext.
 */
export function dedupePluginEntrypoints(files: readonly string[]): string[] {
  const chosen = new Map<string, string>();
  for (const file of files) {
    const stem = file.slice(0, file.length - path.extname(file).length);
    const existing = chosen.get(stem);
    if (!existing) {
      chosen.set(stem, file);
      continue;
    }
    if (classifyPluginEntrypoint(existing) === 'typescript' && classifyPluginEntrypoint(file) === 'javascript') {
      chosen.set(stem, file);
    }
  }
  return [...chosen.values()];
}
