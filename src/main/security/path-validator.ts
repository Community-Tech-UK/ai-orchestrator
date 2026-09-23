import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { isPathWithin } from './canonical-workspace-path';

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

/** Linux's MAXSYMLINKS; beyond this a chain is treated as a loop (ELOOP). */
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve every symlink in `target`, including for paths that do not exist
 * yet (a FILE_WRITE_TEXT target, or one under `createDirs` subdirectories).
 *
 * The nearest existing ancestor is realpath'd and the missing tail appended.
 * A dangling symlink is followed to where a write through it would land, so
 * `allowed/link -> /outside/new-file` resolves outside the root instead of
 * looking like a harmless missing file under `allowed/`.
 */
function resolveRealPath(target: string, hops = 0): string {
  if (hops > MAX_SYMLINK_HOPS) {
    throw new Error(`Too many levels of symbolic links: ${target}`);
  }
  try {
    return fs.realpathSync.native(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error;
    }
  }

  let entry: fs.Stats | undefined;
  try {
    entry = fs.lstatSync(target);
  } catch {
    entry = undefined;
  }
  if (entry?.isSymbolicLink()) {
    const linkDir = resolveRealPath(path.dirname(target), hops + 1);
    return resolveRealPath(path.resolve(linkDir, fs.readlinkSync(target)), hops + 1);
  }

  const parent = path.dirname(target);
  if (parent === target) {
    return target;
  }
  return path.join(resolveRealPath(parent, hops), path.basename(target));
}

export function validatePath(filePath: string): { valid: boolean; resolved: string; error?: string } {
  const resolved = path.resolve(filePath);

  // Block null bytes (path traversal attack)
  if (filePath.includes('\0')) {
    return { valid: false, resolved, error: 'Path contains null byte' };
  }

  if (ALLOWED_ROOTS.length === 0) {
    return { valid: true, resolved };
  }

  // The requested path must sit under an allowed root lexically...
  const lexicallyAllowed = ALLOWED_ROOTS.some((root) => isPathWithin(resolved, root));
  if (!lexicallyAllowed) {
    return { valid: false, resolved, error: `Path outside allowed directories: ${resolved}` };
  }

  // ...and so must the location it actually resolves to. Without this a
  // symlink inside an allowed root (`~/project/link -> /etc/passwd`) passes
  // the string check and the file operation follows it out of the sandbox.
  let realPath: string;
  try {
    realPath = resolveRealPath(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, resolved, error: `Path could not be resolved: ${message}` };
  }
  const realRoots = ALLOWED_ROOTS.flatMap((root) => {
    try {
      return [resolveRealPath(root)];
    } catch {
      return [];
    }
  });
  if (!realRoots.some((root) => isPathWithin(realPath, root))) {
    return {
      valid: false,
      resolved,
      error: `Path outside allowed directories: ${resolved} resolves to ${realPath}`,
    };
  }

  return { valid: true, resolved: realPath };
}
