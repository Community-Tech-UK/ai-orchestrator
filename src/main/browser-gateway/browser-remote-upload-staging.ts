import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getFileTransferService } from '../remote-node/file-transfer-service';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { getLogger } from '../logging/logger';

const logger = getLogger('BrowserRemoteUploadStaging');

export interface BrowserRemoteUploadStagingResult {
  remotePath: string;
  size: number;
  sha256: string;
  integrity: 'size-and-sha256';
}

/**
 * Stage a coordinator-local file onto a remote worker node so the node's
 * Chrome extension can point `DOM.setFileInputFiles` at a path that exists on
 * THAT machine.
 *
 * Without staging, a remote-node existing-tab upload ships the coordinator's
 * local path string to the other machine; Chrome there backs the `<input>`
 * File with a nonexistent path, the page uploads zero/unreadable bytes, and
 * the site fails server-side ("error uploading") — which looks like file
 * corruption but is simply the wrong filesystem.
 *
 * The staged copy lives under the node's first working directory (the only
 * roots its filesystem RPC is allowed to write inside), in `_scratch/`, the
 * convention for disposable artifacts that code indexing ignores.
 */
export async function stageBrowserUploadOnNode(
  nodeId: string,
  localPath: string,
): Promise<BrowserRemoteUploadStagingResult> {
  const node = getWorkerNodeRegistry().getNode(nodeId);
  const stagingRoot = node?.capabilities.workingDirectories[0];
  if (!stagingRoot) {
    throw new Error(
      'upload_file_remote_staging_unavailable: the remote node has no working directory to stage the upload file into',
    );
  }
  // The remote node may run a different OS than the coordinator — join with
  // the path flavor of the NODE's root, not the local platform's.
  const joiner = isWindowsStylePath(stagingRoot) ? path.win32 : path.posix;
  // The UUID is a DIRECTORY component, never part of the basename.
  // `DOM.setFileInputFiles` makes the staged path's filename the name the page
  // -- and whoever receives the upload -- actually sees, so folding the UUID
  // into the basename silently renamed the file mid-flight. On 2026-08-28 that
  // put `<uuid>-Liverpool-...-DRAFT.docx` in front of a public-sector buyer's
  // attachment dialog and blocked an approved tender submission. A directory
  // per staged upload keeps the same collision guarantee and leaves the
  // filename byte-identical to the local file.
  const remotePath = joiner.join(
    stagingRoot,
    '_scratch',
    'aio-browser-uploads',
    randomUUID(),
    sanitizeBasename(localPath, isWindowsStylePath(stagingRoot)),
  );
  const result = await getFileTransferService().copyToRemote({
    localPath,
    remotePath,
    nodeId,
  });
  const staged = {
    remotePath,
    size: result.size,
    sha256: result.sha256,
    integrity: 'size-and-sha256' as const,
  };
  logger.info('Staged browser upload file on remote node with verified integrity', {
    nodeId,
    localPath,
    remotePath,
    size: staged.size,
    sha256: staged.sha256,
  });
  return staged;
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\');
}

function sanitizeBasename(localPath: string, forWindows: boolean): string {
  // Only strip what the TARGET filesystem actually rejects. Applying the Windows
  // rules everywhere renamed legal POSIX names -- `Q1: Response.docx` became
  // `Q1_ Response.docx` -- which is Defect 1's own class, a document renamed in
  // front of the recipient.
  const separatorsAndControls = forWindows
    // eslint-disable-next-line no-control-regex
    ? /[<>:"/\\|?*\u0000-\u001f\u007f]/g
    // eslint-disable-next-line no-control-regex
    : /[/\u0000]/g;
  let cleaned = path.basename(localPath).replace(separatorsAndControls, '_');
  if (forWindows) {
    // Windows silently drops a trailing dot or space, so a name relying on one
    // would not round-trip.
    cleaned = cleaned.replace(/[ .]+$/, '').trim();
  }
  // "." and ".." are traversal, not filenames. A LEADING dot is otherwise legal
  // and meaningful (.htaccess), and stripping it renamed the file -- the thing
  // this module exists to stop -- so it is preserved.
  if (!cleaned || /^\.+$/.test(cleaned)) {
    return 'upload.bin';
  }
  // Windows resolves these names to devices whatever the extension, and the
  // staging target is a Windows node, so `CON.docx` would never become a file.
  const withoutDeviceName = forWindows
    && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)
    ? `file-${cleaned}`
    : cleaned;
  return truncateFilenameToBytes(withoutDeviceName, 255);
}

/**
 * ext4 caps a filename component at 255 BYTES (NTFS at 255 UTF-16 units), so
 * measure bytes: a 255-character accented name still fails ENAMETOOLONG on a
 * Linux node. Truncate the stem and keep the extension, so the receiving site
 * still sees the right file type, and iterate by code point so a surrogate pair
 * is never split into a lone surrogate.
 */
function truncateFilenameToBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) {
    return name;
  }
  const extension = path.extname(name);
  // A very long "extension" is not one; drop it rather than spend the budget.
  const keptExtension = Buffer.byteLength(extension, 'utf8') <= 24 ? extension : '';
  const budget = maxBytes - Buffer.byteLength(keptExtension, 'utf8');
  const stem = name.slice(0, name.length - extension.length);
  let truncated = '';
  for (const character of stem) {
    if (Buffer.byteLength(truncated + character, 'utf8') > budget) {
      break;
    }
    truncated += character;
  }
  return `${truncated}${keptExtension}` || 'upload.bin';
}
