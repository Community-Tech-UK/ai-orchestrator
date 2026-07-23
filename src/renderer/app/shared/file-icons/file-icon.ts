/**
 * File-type icon resolver — maps a file path to its Seti glyph + colour.
 *
 * Mirrors VS Code's icon-theme resolution order so the result matches the
 * default (Seti) file-icon theme:
 *   1. exact basename match (case-insensitive) — e.g. `Dockerfile`, `.gitignore`,
 *   2. longest compound extension — e.g. `spec.ts`, `css.map` (try the longest
 *      dotted suffix first),
 *   3. plain extension,
 *   4. the default file glyph.
 *
 * The lookup tables are generated from the vendored Seti theme by
 * `scripts/generate-seti-icon-map.ts` (`npm run generate:file-icons`).
 *
 * Built shared-ready under `src/renderer/app/shared/` — the Source Control view
 * is the first consumer; other surfaces (file explorer, attachments) can reuse
 * it later without change.
 */

import {
  SETI_DEFAULT_ICON,
  SETI_EXTENSION_ICONS,
  SETI_FILENAME_ICONS,
  type FileIconDef,
} from './file-icon-map.generated';

export type { FileIconDef } from './file-icon-map.generated';
export { SETI_DEFAULT_ICON } from './file-icon-map.generated';

/** Extract the basename from a `/`- or `\`-separated path. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Resolve the Seti file icon for a path. Accepts a bare filename or a full
 * (possibly nested) path; only the basename is used for matching.
 */
export function resolveFileIcon(path: string): FileIconDef {
  const name = basename(path).toLowerCase();
  if (!name) return SETI_DEFAULT_ICON;

  // 1. Exact filename match.
  const byName = SETI_FILENAME_ICONS[name];
  if (byName) return byName;

  // 2 + 3. Extension matches, longest compound suffix first. For
  // `foo.spec.ts` this tries `spec.ts` then `ts`; for `a.b.c` it tries
  // `b.c` then `c`. The leading segment before the first dot is the base
  // name, never an extension.
  const parts = name.split('.');
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('.');
    const byExt = SETI_EXTENSION_ICONS[candidate];
    if (byExt) return byExt;
  }

  // 4. Default file glyph.
  return SETI_DEFAULT_ICON;
}
