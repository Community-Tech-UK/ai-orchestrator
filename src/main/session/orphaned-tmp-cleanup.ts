import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'fs/promises';
import { getLogger } from '../logging/logger';
import {
  getContinuityStagingPath,
  parseContinuityStagingFileName,
} from './continuity-staging-file';

const logger = getLogger('SessionRepair');

export interface TmpCleanupResult {
  recovered: string[];
  deleted: string[];
  failed: string[];
}

export type TmpPromotionValidator = (
  claimedPath: string,
  finalPath: string,
  handle: FileHandle,
) => TmpPromotionValidation | boolean | Promise<TmpPromotionValidation | boolean>;

export interface TmpPromotionValidation {
  valid: boolean;
  canPromote?: () => boolean;
}

export interface TmpCleanupFileOperations {
  linkNoOverwrite?: (claimedPath: string, finalPath: string) => fs.Stats;
  afterLink?: (claimedPath: string, finalPath: string) => void;
}

interface TmpCandidate {
  fileName: string;
  sourcePath: string;
  claimedPath: string;
  finalFileName: string;
  finalPath: string;
  mtimeMs: number;
  writerProcessId: number;
  writerStartedAt: number;
  sequence: number;
  claimedIdentity: fs.Stats;
}

async function deleteTmpCandidate(
  candidate: TmpCandidate,
  result: TmpCleanupResult,
): Promise<void> {
  try {
    const currentStat = await fs.promises.lstat(candidate.claimedPath);
    if (!isSameFileIdentity(currentStat, candidate.claimedIdentity)) {
      result.failed.push(candidate.claimedPath);
      return;
    }
    await fs.promises.unlink(candidate.claimedPath);
    result.deleted.push(candidate.sourcePath);
  } catch {
    result.failed.push(candidate.claimedPath);
  }
}

function isPromotableClaim(stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function isSameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSameClaimGeneration(left: fs.Stats, right: fs.Stats): boolean {
  return isSameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

function isSameValidatedContent(left: fs.Stats, right: fs.Stats): boolean {
  return isSameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function normalizePromotionValidation(
  validation: TmpPromotionValidation | boolean,
): TmpPromotionValidation {
  return typeof validation === 'boolean' ? { valid: validation } : validation;
}

interface ValidatedTmpCandidate {
  candidate: TmpCandidate;
  handle: FileHandle;
  validation: TmpPromotionValidation;
  validatedStat: fs.Stats;
  validatedDigest: string;
}

async function digestOpenFile(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function digestOpenFileSync(fd: number, size: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const bytesRead = fs.readSync(fd, buffer, 0, length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

async function validateClaimedTmpCandidate(
  candidate: TmpCandidate,
  validateCandidate: TmpPromotionValidator,
): Promise<ValidatedTmpCandidate | null> {
  let handle: FileHandle | null = null;
  let keepOpen = false;
  try {
    const claimedStat = await fs.promises.lstat(candidate.claimedPath);
    if (!isPromotableClaim(claimedStat)) return null;
    handle = await fs.promises.open(
      candidate.claimedPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedStat = await handle.stat();
    if (!isPromotableClaim(openedStat) || !isSameClaimGeneration(claimedStat, openedStat)) {
      return null;
    }
    const validation = normalizePromotionValidation(
      await validateCandidate(candidate.claimedPath, candidate.finalPath, handle),
    );
    if (!validation.valid) return null;
    const validatedBeforeDigest = await handle.stat();
    if (!isPromotableClaim(validatedBeforeDigest)
      || !isSameClaimGeneration(openedStat, validatedBeforeDigest)) {
      return null;
    }
    const validatedDigest = await digestOpenFile(handle, validatedBeforeDigest.size);
    const validatedStat = await handle.stat();
    if (!isPromotableClaim(validatedStat)
      || !isSameClaimGeneration(validatedBeforeDigest, validatedStat)) return null;
    keepOpen = true;
    return { candidate, handle, validation, validatedStat, validatedDigest };
  } catch {
    return null;
  } finally {
    if (!keepOpen) await handle?.close().catch(() => undefined);
  }
}

type TmpPromotionResult = 'recovered' | 'stale' | 'exists' | 'failed';

function unlinkOwnedPromotionLink(
  finalPath: string,
  linkedGeneration: fs.Stats | undefined,
): boolean {
  if (!linkedGeneration) return false;
  try {
    const current = fs.lstatSync(finalPath);
    if (!isSameClaimGeneration(current, linkedGeneration)) return false;
    fs.unlinkSync(finalPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function isOwnedLinkedPromotionGeneration(
  selected: ValidatedTmpCandidate,
  linkedGeneration: fs.Stats | undefined,
  openedAfterLinkStat: fs.Stats,
): linkedGeneration is fs.Stats {
  if (!linkedGeneration) return false;
  return linkedGeneration.isFile()
    && !linkedGeneration.isSymbolicLink()
    && openedAfterLinkStat.isFile()
    && !openedAfterLinkStat.isSymbolicLink()
    && linkedGeneration.nlink === 2
    && openedAfterLinkStat.nlink === 2
    && isSameClaimGeneration(linkedGeneration, openedAfterLinkStat)
    && isSameValidatedContent(selected.validatedStat, openedAfterLinkStat)
    && digestOpenFileSync(selected.handle.fd, openedAfterLinkStat.size)
      === selected.validatedDigest;
}

function promoteValidatedTmpCandidate(
  selected: ValidatedTmpCandidate,
  result: TmpCleanupResult,
  operations: TmpCleanupFileOperations,
): TmpPromotionResult {
  let linkedFinal = false;
  let linkedGeneration: fs.Stats | undefined;
  try {
    if (selected.validation.canPromote && !selected.validation.canPromote()) return 'stale';
    const claimedStat = fs.lstatSync(selected.candidate.claimedPath);
    const openedStat = fs.fstatSync(selected.handle.fd);
    if (!isPromotableClaim(claimedStat)
      || !isPromotableClaim(openedStat)
      || !isSameClaimGeneration(selected.validatedStat, claimedStat)
      || !isSameClaimGeneration(selected.validatedStat, openedStat)) return 'stale';
    const returnedLinkedGeneration: fs.Stats | undefined = operations.linkNoOverwrite
      ? operations.linkNoOverwrite(
          selected.candidate.claimedPath,
          selected.candidate.finalPath,
        )
      : (() => {
          fs.linkSync(selected.candidate.claimedPath, selected.candidate.finalPath);
          return fs.fstatSync(selected.handle.fd);
        })();
    const openedAfterLinkStat = fs.fstatSync(selected.handle.fd);
    if (!isOwnedLinkedPromotionGeneration(
      selected,
      returnedLinkedGeneration,
      openedAfterLinkStat,
    )) {
      throw new Error('linkNoOverwrite did not return an owned two-link generation');
    }
    linkedGeneration = returnedLinkedGeneration;
    linkedFinal = true;
    operations.afterLink?.(selected.candidate.claimedPath, selected.candidate.finalPath);
    const promotedStat = fs.lstatSync(selected.candidate.finalPath);
    const openedAfterHookStat = fs.fstatSync(selected.handle.fd);
    if (!promotedStat.isFile()
      || promotedStat.isSymbolicLink()
      || !isSameClaimGeneration(promotedStat, openedAfterHookStat)
      || promotedStat.nlink !== 2
      || openedAfterHookStat.nlink !== 2
      || !isSameValidatedContent(selected.validatedStat, openedAfterHookStat)
      || digestOpenFileSync(selected.handle.fd, openedAfterHookStat.size)
        !== selected.validatedDigest) {
      linkedFinal = !unlinkOwnedPromotionLink(
        selected.candidate.finalPath,
        linkedGeneration,
      );
      return 'stale';
    }
    result.recovered.push(selected.candidate.finalPath);
    try {
      const claimedAfterLinkStat = fs.lstatSync(selected.candidate.claimedPath);
      if (isSameClaimGeneration(claimedAfterLinkStat, openedAfterHookStat)) {
        fs.unlinkSync(selected.candidate.claimedPath);
      } else {
        result.failed.push(selected.candidate.claimedPath);
      }
    } catch {
      result.failed.push(selected.candidate.claimedPath);
    }
    return 'recovered';
  } catch (error) {
    if (linkedFinal) {
      try {
        linkedFinal = !unlinkOwnedPromotionLink(
          selected.candidate.finalPath,
          linkedGeneration,
        );
      } catch {
        result.failed.push(selected.candidate.finalPath);
        throw error;
      }
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    result.failed.push(selected.candidate.claimedPath);
    return 'failed';
  }
}

async function finalPathExists(finalPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(finalPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Resolve legacy and process-unique crash staging files without overwriting a final file. */
export async function cleanupOrphanedTmpFiles(
  dir: string,
  validateCandidate: TmpPromotionValidator = () => true,
  operations: TmpCleanupFileOperations = {},
): Promise<TmpCleanupResult> {
  const result: TmpCleanupResult = { recovered: [], deleted: [], failed: [] };

  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    logger.error('Cannot read directory for tmp cleanup', err as Error, { dir });
    return result;
  }

  const grouped = new Map<string, TmpCandidate[]>();
  for (const fileName of entries) {
    const stagingName = parseContinuityStagingFileName(fileName);
    if (!stagingName) continue;
    const { finalFileName } = stagingName;
    const sourcePath = path.join(dir, fileName);
    const finalPath = path.join(dir, finalFileName);
    const claimedPath = getContinuityStagingPath(finalPath);
    try {
      await fs.promises.rename(sourcePath, claimedPath);
      const stat = await fs.promises.lstat(claimedPath);
      const candidate: TmpCandidate = {
        fileName, sourcePath, claimedPath, finalFileName, finalPath,
        mtimeMs: stat.mtimeMs,
        writerProcessId: stagingName.writerProcessId,
        writerStartedAt: stagingName.writerStartedAt,
        sequence: stagingName.sequence,
        claimedIdentity: stat,
      };
      const candidates = grouped.get(finalFileName) ?? [];
      candidates.push(candidate);
      grouped.set(finalFileName, candidates);
    } catch {
      result.failed.push(sourcePath);
    }
  }

  for (const finalFileName of [...grouped.keys()].sort()) {
    const candidates = grouped.get(finalFileName)!;
    candidates.sort((left, right) =>
      right.mtimeMs - left.mtimeMs
      || right.writerStartedAt - left.writerStartedAt
      || right.writerProcessId - left.writerProcessId
      || right.sequence - left.sequence
      || right.fileName.localeCompare(left.fileName));
    let finalExists: boolean;
    try {
      finalExists = await finalPathExists(candidates[0].finalPath);
    } catch {
      result.failed.push(...candidates.map((candidate) => candidate.claimedPath));
      continue;
    }
    if (finalExists) {
      await Promise.all(candidates.map((candidate) => deleteTmpCandidate(candidate, result)));
      continue;
    }

    const skipCleanup = new Set<TmpCandidate>();
    for (const candidate of candidates) {
      const selected = await validateClaimedTmpCandidate(candidate, validateCandidate);
      if (!selected) continue;
      let promotion: TmpPromotionResult;
      try {
        promotion = promoteValidatedTmpCandidate(selected, result, operations);
      } finally {
        await selected.handle.close().catch(() => undefined);
      }
      if (promotion === 'recovered' || promotion === 'failed') {
        skipCleanup.add(candidate);
        break;
      }
      if (promotion === 'exists') break;
    }
    await Promise.all(candidates
      .filter((candidate) => !skipCleanup.has(candidate))
      .map((candidate) => deleteTmpCandidate(candidate, result)));
  }

  if (result.recovered.length || result.deleted.length || result.failed.length) {
    logger.info('Orphaned tmp cleanup completed', {
      dir,
      recovered: result.recovered.length,
      deleted: result.deleted.length,
      failed: result.failed.length,
    });
  }

  return result;
}
