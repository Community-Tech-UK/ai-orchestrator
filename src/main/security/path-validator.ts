import * as path from 'path';
import { app } from 'electron';

const ALLOWED_ROOTS: string[] = [];

/**
 * Initialize the renderer-facing path sandbox.
 *
 * The renderer is already isolated (sandbox:true, contextIsolation:true,
 * nodeIntegration:false). This allowlist is defense-in-depth against IPC
 * misuse: it gates `FILE_READ_TEXT` / `FILE_READ_BYTES` / `FILE_WRITE_TEXT`
 * to a small set of roots even if the renderer is compromised.
 *
 * The roots are deliberately broad because the typical use is user-initiated
 * — VSCode/Finder drag-drop, "Add files…" pickers, workspace project files.
 * Adding the user's home directory makes those everyday flows work without
 * the user having to register each path; system locations (`/etc`, `/System`,
 * `/usr`, …) remain implicitly blocked.
 *
 * For non-home roots (external drives, `/Volumes/...`, `/opt/...`), the
 * `addAllowedRoot` helper is called from chat-service.ts (`createChat`,
 * `setCwd`, and on startup for already-persisted chats) and
 * instance-manager.ts (`createInstance`) so any working directory the user
 * has explicitly authorized for a chat/instance is readable.
 */
export function initializePathValidator(): void {
  ALLOWED_ROOTS.push(
    app.getPath('userData'),
    app.getPath('temp'),
    app.getPath('home'),
    process.cwd()
  );
}

export function addAllowedRoot(dir: string): void {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (!ALLOWED_ROOTS.includes(resolved)) {
    ALLOWED_ROOTS.push(resolved);
  }
}

export function validatePath(filePath: string): { valid: boolean; resolved: string; error?: string } {
  const resolved = path.resolve(filePath);

  // Block null bytes (path traversal attack)
  if (filePath.includes('\0')) {
    return { valid: false, resolved, error: 'Path contains null byte' };
  }

  // Check against allowed roots
  const isAllowed = ALLOWED_ROOTS.some(root => resolved.startsWith(root + path.sep) || resolved === root);
  if (!isAllowed && ALLOWED_ROOTS.length > 0) {
    return { valid: false, resolved, error: `Path outside allowed directories: ${resolved}` };
  }

  return { valid: true, resolved };
}
