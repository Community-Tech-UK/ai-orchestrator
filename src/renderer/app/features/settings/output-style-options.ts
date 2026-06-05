/**
 * Pure helpers for the output-style picker in the Ecosystem settings tab
 * (claude2_todo #29 — user-facing slice).
 *
 * The main process is the source of truth: it ships the built-in styles
 * (`listOutputStyles()` in `src/main/instance/output-style.ts`) and the
 * user-authored `.md` styles (`OutputStyleRegistry.listUserStyles()`), both
 * delivered to the renderer in the `ECOSYSTEM_LIST` payload. This module just
 * merges those two lists into a single, de-duplicated, render-ready option list
 * — extracted as a pure function so it can be unit-tested without standing up
 * the (heavily IPC-coupled) tab component.
 */

export type OutputStyleSource = 'built-in' | 'user';
export type OutputStyleMode = 'append' | 'replace';

/** A built-in output style as delivered by the ecosystem payload. */
export interface BuiltInOutputStyleDto {
  name: string;
  label: string;
}

/** A user-authored output style as delivered by the ecosystem payload. */
export interface UserOutputStyleDto {
  name: string;
  label: string;
  description?: string;
  mode?: OutputStyleMode;
  filePath?: string;
}

/** A render-ready picker option (built-in or user). */
export interface OutputStyleOption {
  name: string;
  label: string;
  source: OutputStyleSource;
  description?: string;
  mode?: OutputStyleMode;
  filePath?: string;
}

const DEFAULT_OPTION: OutputStyleOption = {
  name: 'default',
  label: 'Default',
  source: 'built-in',
};

/**
 * Merge built-in + user output styles into one ordered, de-duplicated option
 * list for the picker.
 *
 * - Built-ins come first (matching the backend's resolution precedence).
 * - The inert `default` style is always present and first, even before the
 *   ecosystem payload has loaded, so the picker is never empty and the user can
 *   always return to the no-op style.
 * - Built-in names are reserved: a user style colliding with a built-in name is
 *   dropped (the backend already enforces this, but the renderer stays
 *   defensive). First occurrence of any name wins.
 */
export function mergeOutputStyleOptions(
  builtIns: readonly BuiltInOutputStyleDto[] | undefined,
  userStyles: readonly UserOutputStyleDto[] | undefined,
): OutputStyleOption[] {
  const options: OutputStyleOption[] = [];
  const seen = new Set<string>();

  for (const b of builtIns ?? []) {
    if (!b?.name || seen.has(b.name)) continue;
    seen.add(b.name);
    options.push({ name: b.name, label: b.label || b.name, source: 'built-in' });
  }

  if (!seen.has('default')) {
    options.unshift(DEFAULT_OPTION);
    seen.add('default');
  }

  for (const u of userStyles ?? []) {
    if (!u?.name || seen.has(u.name)) continue;
    seen.add(u.name);
    options.push({
      name: u.name,
      label: u.label || u.name,
      source: 'user',
      ...(u.description ? { description: u.description } : {}),
      ...(u.mode ? { mode: u.mode } : {}),
      ...(u.filePath ? { filePath: u.filePath } : {}),
    });
  }

  return options;
}
