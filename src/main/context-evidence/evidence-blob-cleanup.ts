import { isAbsolute, relative, sep } from 'node:path';
import { join } from 'node:path';
import { EvidenceStorageError, type EvidenceStorageFileSystem, type EvidenceStagingCleanupOptions } from './evidence-storage.types';
import { performSecureDirectoryOperation, type BeforeDirectoryOperation } from './secure-directory-operation';

export interface EvidenceCleanupDirectory {
  path: string;
  realPath: string;
  device: number;
  inode: number;
}

interface CleanupOwner {
  storagePath: string;
  fileSystem: EvidenceStorageFileSystem;
  activeWrites: ReadonlySet<string>;
  publicationEpoch: () => number;
  publications: () => number;
  ensureSafeRoot: () => Promise<EvidenceCleanupDirectory>;
  verifyDirectoryIdentity: (identity: EvidenceCleanupDirectory) => Promise<void>;
  captureDirectoryIdentity: (path: string) => Promise<EvidenceCleanupDirectory>;
  syncDirectory: (identity: EvidenceCleanupDirectory) => Promise<void>;
  beforeDirectoryOperation?: BeforeDirectoryOperation;
}

/** Bounded, cancellable cleanup. Publication ownership and fresh references are
 * conservative guards; partial enumeration is never supplied by maintenance.
 */
export async function cleanupEvidenceFiles(
  owner: CleanupOwner,
  shouldRemove: (directoryRef: string, name: string) => boolean,
  options: EvidenceStagingCleanupOptions,
  findReferencedCandidates?: (refs: string[]) => Promise<string[]>,
): Promise<number> {
  const olderThanMs = Math.max(0, options.olderThanMs ?? 0);
  const cutoff = (options.now ?? Date.now()) - olderThanMs;
  const root = await owner.ensureSafeRoot();
  let removed = 0;
  try {
    options.signal?.throwIfAborted();
    await owner.verifyDirectoryIdentity(root);
    const directories = await owner.fileSystem.readdir(owner.storagePath, { withFileTypes: true });
    await owner.verifyDirectoryIdentity(root);
    for (const directory of directories) {
      options.signal?.throwIfAborted();
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      if (!/^[a-f0-9]{64}$/.test(directory.name)) continue;
      const directoryPath = join(owner.storagePath, directory.name);
      await owner.verifyDirectoryIdentity(root);
      const directoryIdentity = await owner.captureDirectoryIdentity(directoryPath);
      if (!isPathInside(directoryIdentity.realPath, root.realPath)) {
        throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      }
      await owner.verifyDirectoryIdentity(directoryIdentity);
      const entries = await owner.fileSystem.readdir(directoryPath, { withFileTypes: true });
      await owner.verifyDirectoryIdentity(directoryIdentity);
      let removedFromDirectory = false;
      for (let offset = 0; offset < entries.length; offset += 100) {
        options.signal?.throwIfAborted();
        const batch = entries.slice(offset, offset + 100);
        const candidates = batch.filter((entry) => entry.isFile() && !entry.isSymbolicLink()
          && shouldRemove(directory.name, entry.name));
        const epoch = owner.publicationEpoch();
        const freshRefs = new Set(findReferencedCandidates
          ? await findReferencedCandidates(candidates.map((entry) => `${directory.name}/${entry.name}`))
          : []);
        for (const entry of candidates) {
          options.signal?.throwIfAborted();
          if (!entry.isFile() || entry.isSymbolicLink() || !shouldRemove(directory.name, entry.name)) {
            continue;
          }
          const candidatePath = join(directoryPath, entry.name);
          if (freshRefs.has(`${directory.name}/${entry.name}`) || owner.activeWrites.has(candidatePath)
            || owner.publications() > 0 || epoch !== owner.publicationEpoch()) continue;
          await owner.verifyDirectoryIdentity(directoryIdentity);
          const stat = await owner.fileSystem.lstat(candidatePath);
          await owner.verifyDirectoryIdentity(directoryIdentity);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue;
          await owner.verifyDirectoryIdentity(directoryIdentity);
          options.signal?.throwIfAborted();
          const current = await owner.fileSystem.lstat(candidatePath);
          if (!current.isFile() || current.isSymbolicLink() || current.mtimeMs > cutoff
            || current.ino !== stat.ino || current.dev !== stat.dev) continue;
          // The hook can yield; recheck after it, immediately before spawning
          // the directory-bound operation. Cancellation must propagate unchanged.
          let skipped = false;
          const beforeRemove: BeforeDirectoryOperation = async (notice) => {
            await owner.beforeDirectoryOperation?.(notice);
            options.signal?.throwIfAborted();
            await owner.verifyDirectoryIdentity(root);
            await owner.verifyDirectoryIdentity(directoryIdentity);
            const latest = await owner.fileSystem.lstat(candidatePath);
            options.signal?.throwIfAborted();
            if (owner.activeWrites.has(candidatePath) || owner.publications() > 0
              || epoch !== owner.publicationEpoch() || !latest.isFile() || latest.isSymbolicLink()
              || latest.mtimeMs > cutoff || latest.ino !== stat.ino || latest.dev !== stat.dev) {
              skipped = true;
              throw new Error('EVIDENCE_CLEANUP_PUBLICATION_CHANGED');
            }
          };
          try {
            await performSecureDirectoryOperation(directoryIdentity, {
              kind: 'remove',
              sourceName: entry.name,
            }, beforeRemove, options.signal);
          } catch (error) {
            if (!skipped) throw error;
            continue;
          }
          await owner.verifyDirectoryIdentity(directoryIdentity);
          removed += 1;
          removedFromDirectory = true;
        }
        // Give captures and reads a turn between bounded filesystem batches.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (removedFromDirectory) {
        await owner.syncDirectory(directoryIdentity);
      }
    }
    return removed;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof EvidenceStorageError) throw error;
    throw new EvidenceStorageError('CLEANUP_FAILED');
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
