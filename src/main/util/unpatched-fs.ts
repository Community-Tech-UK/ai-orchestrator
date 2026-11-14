import type * as NodeFs from 'node:fs';
import * as nodeFs from 'node:fs';

/**
 * The real filesystem, for walking trees Harness did not write itself.
 *
 * Inside Electron, `fs` treats every `.asar` file as a folder: `lstat` reports
 * it as a directory, then `opendir` fails with ENOTDIR and a recursive `rm` or
 * `cp` half-finishes or never settles. Every `node_modules/electron` holds one
 * (`default_app.asar`), so any scan, hash or copy of a checkout needs this.
 * `original-fs` is Electron's unpatched `fs`; outside Electron plain `fs` is
 * already unpatched.
 */
export function unpatchedFs(): typeof NodeFs {
  if (!process.versions.electron) return nodeFs;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('original-fs') as typeof NodeFs;
}
