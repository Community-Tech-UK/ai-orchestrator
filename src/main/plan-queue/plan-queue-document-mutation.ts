/** Non-destructive claims for shared root documents. Never truncate or unlink an input. */
import * as disk from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DocumentFileIdentity {
  file: string;
  stat: disk.Stats;
  ancestors: { folder: string; stat: disk.Stats }[];
}
const same = (a: disk.Stats, b: disk.Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;

/** `.<name>.aio-retained-<uuid>` holds the version an update replaced; `.aio-prepared-` is unpublished output left by a failure. */
const recoveryCopyName = (file: string, kind: 'retained' | 'prepared'): string => `.${path.basename(file)}.aio-${kind}-${randomUUID()}`;
const RECOVERY_COPY_NAME = /^\..+\.aio-(?:retained|prepared)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** True only for a name `changeDocumentFile` writes beside a document. */
export const isRecoveryCopyName = (name: string): boolean => RECOVERY_COPY_NAME.test(name);

export function documentFileIdentity(file: string): DocumentFileIdentity {
  file = path.resolve(file);
  const ancestors: DocumentFileIdentity['ancestors'] = [];
  for (let folder = path.dirname(file); ; folder = path.dirname(folder)) {
    const stat = disk.lstatSync(folder);
    if (!stat.isDirectory()) throw new Error('Document changes require regular directory ancestors');
    ancestors.push({ folder, stat });
    if (folder === path.dirname(folder)) break;
  }
  const stat = disk.lstatSync(file);
  if (!stat.isFile()) throw new Error('Document changes require a regular file');
  return { file, stat, ancestors };
}

function ancestorsUnchanged(identity: DocumentFileIdentity): boolean {
  return identity.ancestors.every(({ folder, stat }) => same(stat, disk.lstatSync(folder)));
}
function unchanged(identity: DocumentFileIdentity, file: string, expected: Buffer): boolean {
  if (!ancestorsUnchanged(identity)) return false;
  const stat = disk.lstatSync(file);
  if (!stat.isFile() || !same(identity.stat, stat)) return false;
  const fd = disk.openSync(file, disk.constants.O_RDONLY | disk.constants.O_NOFOLLOW);
  try { return same(stat, disk.fstatSync(fd)) && disk.readFileSync(fd).equals(expected); }
  finally { disk.closeSync(fd); }
}

export function assertDocumentFileUnchanged(identity: DocumentFileIdentity, expected: Buffer): void {
  if (!unchanged(identity, identity.file, expected)) throw new Error('The document changed while it was being read; check it again.');
}

/**
 * There is no portable compare-and-unlink/replace syscall. Move the original to
 * a unique retained name, verify what was actually moved, then create exclusively.
 * Retain that inode even on success: a writer that opened it before the claim may
 * append later. These recovery files are never completed documents; the queue deletes
 * them a week after they were last changed (plan-queue-recovery-copies.ts).
 * No await separates the last validation and claim; post-claim validation also
 * catches external writers/replacements. A racing new active file is never replaced.
 */
export function changeDocumentFile(identity: DocumentFileIdentity, before: Buffer, after: string | Buffer | null): void {
  if (!unchanged(identity, identity.file, before)) throw new Error('The document changed while preparing the update; check it again.');
  const retained = path.join(path.dirname(identity.file), recoveryCopyName(identity.file, 'retained'));
  disk.renameSync(identity.file, retained);
  try {
    if (!unchanged(identity, retained, before)) throw new Error('The document changed while applying the update; check it again.');
    if (after !== null) {
      // Publish complete bytes exclusively: never expose an empty active file to another writer.
      const temporary = path.join(path.dirname(identity.file), recoveryCopyName(identity.file, 'prepared'));
      const bytes = typeof after === 'string' ? Buffer.from(after, 'utf8') : after;
      const fd = disk.openSync(temporary, disk.constants.O_WRONLY | disk.constants.O_CREAT | disk.constants.O_EXCL | disk.constants.O_NOFOLLOW, identity.stat.mode & 0o777);
      const output = { ...identity, stat: disk.fstatSync(fd) };
      try {
        disk.writeFileSync(fd, bytes); disk.fsyncSync(fd);
        if (!unchanged(output, temporary, bytes) || !unchanged(identity, retained, before)) throw new Error('The document changed before publication.');
        disk.linkSync(temporary, identity.file);
        if (!unchanged(output, identity.file, bytes)) throw new Error('The updated document changed before it could be accepted.');
      } finally {
        disk.closeSync(fd);
        // Only remove our unchanged private alias. Changed output remains available for recovery.
        if (ancestorsUnchanged(identity) && unchanged(output, temporary, bytes)) disk.unlinkSync(temporary);
      }
    } else {
      try { disk.lstatSync(identity.file); throw new Error('A new document appeared during retirement; check it again.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!unchanged(identity, retained, before)) throw new Error('The original document changed during the update; check its retained copy.');
  } catch (error) {
    // Exclusive restoration never overwrites a new file. Preserve both copies if
    // another writer won the active name or changed an ancestor during the claim.
    const folder = disk.realpathSync(path.dirname(retained));
    const original = path.join(folder, path.basename(retained));
    const active = path.join(folder, path.basename(identity.file));
    try {
      if (disk.lstatSync(original).isSymbolicLink()) disk.symlinkSync(disk.readlinkSync(original), active);
      else disk.linkSync(original, active);
    } catch (restore) {
      if ((restore as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`The original document is retained at ${retained}`, { cause: restore });
    }
    throw new Error(`Document update stopped; the original is retained at ${retained}`, { cause: error });
  }
}
