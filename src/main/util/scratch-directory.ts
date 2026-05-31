/**
 * Scratch directory for "general chats" — sessions that aren't tied to a
 * project workspace. A general chat still needs a real, valid working
 * directory for the CLI process to run in (file reads, tool calls, the file
 * explorer all assume a real path), so we give every general chat the same
 * dedicated scratch folder under the user's home directory.
 *
 * The renderer groups any session whose working directory equals this path
 * under a single "Chats" rail group (see instance-list.component.ts), so the
 * exact path constant must be stable and resolved the same way everywhere.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

/**
 * Resolve the user's home directory. Prefers Electron's `app.getPath('home')`
 * (honours packaged-app HOME semantics) and falls back to `os.homedir()` for
 * tests and non-Electron contexts where `app` may be unavailable.
 */
function resolveHome(): string {
  try {
    if (app?.getPath) {
      const home = app.getPath('home');
      if (home) {
        return home;
      }
    }
  } catch {
    // app not ready / unavailable — fall through to os.homedir()
  }
  return os.homedir();
}

/**
 * Absolute path to the general-chat scratch directory:
 * `<home>/.ai-orchestrator/scratch`. Pure — does not touch the filesystem.
 */
export function getScratchDirectory(): string {
  return path.join(resolveHome(), '.ai-orchestrator', 'scratch');
}

/**
 * Ensure the scratch directory exists and return its absolute path. Safe to
 * call repeatedly (recursive mkdir is idempotent).
 */
export function ensureScratchDirectory(): string {
  const dir = getScratchDirectory();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: if creation fails the CLI spawn will surface the real error.
  }
  return dir;
}
