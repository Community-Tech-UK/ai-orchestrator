import * as path from 'node:path';
import type { QueueJobFolders } from './queue-job-env';

function fold(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Is `candidate` the folder itself or inside it? (Case-insensitive on Windows, as the allowed-list check is.) */
export function isSameOrInsideFolder(candidate: string, folder: string): boolean {
  const [a, b] = [fold(candidate), fold(folder)];
  return a === b || a.startsWith(b + path.sep);
}

/** Does any of these sessions have one of `folders` as, or inside, its working directory or extra folders? */
export function anySessionInFolders(
  sessions: readonly { workingDirectory: string; additionalDirectories?: string[] }[],
  folders: readonly string[],
): boolean {
  return sessions.some(session => [session.workingDirectory, ...(session.additionalDirectories ?? [])]
    .some(directory => folders.some(folder => isSameOrInsideFolder(directory, folder))));
}

/**
 * The folders a queue job's session may use beyond the worker's normal list, kept per job folder and used only
 * for a session whose working directory IS that job folder. Held in memory: a worker restart ends the session, and
 * the next `queue.prepare` registers the folders again.
 */
export class QueueJobFolderRegistry {
  private readonly jobs = new Map<string, QueueJobFolders>();

  register(folders: QueueJobFolders): void {
    this.jobs.set(fold(folders.jobFolder), {
      jobFolder: path.resolve(folders.jobFolder),
      planningFolder: path.resolve(folders.planningFolder),
      reportFolder: path.resolve(folders.reportFolder),
    });
  }

  unregister(jobFolder: string): void {
    this.jobs.delete(fold(jobFolder));
  }

  /** The worker's normal list, plus the three folders when a session's working directory is a registered job folder. */
  allowedFor(allowedDirs: readonly string[], workingDirectory: string): string[] {
    const folders = this.jobs.get(fold(workingDirectory));
    return folders ? [...allowedDirs, folders.jobFolder, folders.planningFolder, folders.reportFolder] : [...allowedDirs];
  }
}
