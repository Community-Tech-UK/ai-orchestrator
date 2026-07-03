import fs from 'node:fs/promises';
import path from 'node:path';
import { SecurityFilter } from './security-filter';
import type { DiscoveredProject } from '../../shared/types/remote-fs.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('ProjectDiscovery');

const MAX_DEPTH = 4;

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  '.sln',
  '.csproj',
  'pom.xml',
  'build.gradle',
];

export class ProjectDiscovery {
  private cachedProjects: DiscoveredProject[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  async scan(roots: string[]): Promise<DiscoveredProject[]> {
    const results: DiscoveredProject[] = [];

    for (const root of roots) {
      await this.scanDirectory(root, 0, results);
    }

    this.cachedProjects = results;
    logger.info('Scan complete', { count: results.length });
    return results;
  }

  getCachedProjects(): DiscoveredProject[] {
    return this.cachedProjects;
  }

  startPeriodicScan(roots: string[], intervalMs = 5 * 60 * 1000): void {
    void this.scan(roots);
    this.scanTimer = setInterval(() => {
      void this.scan(roots);
    }, intervalMs);
  }

  stopPeriodicScan(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private async scanDirectory(
    dirPath: string,
    depth: number,
    results: DiscoveredProject[]
  ): Promise<void> {
    if (depth > MAX_DEPTH) {
      return;
    }

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true, encoding: 'utf8' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      // A broad root (e.g. the home directory) inevitably descends into
      // OS-locked system folders — Windows `AppData\Local\ElevatedDiagnostics`,
      // macOS protected `Library` subdirs. Permission-denied / missing / not-a-dir
      // results are expected there and must NOT masquerade as failures; log them
      // at debug. Reserve warn for genuinely unexpected read errors.
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
        logger.debug('Skipping unreadable directory during scan', { dirPath, code });
      } else {
        logger.warn('Failed to read directory', { dirPath, err: String(err) });
      }
      return;
    }

    // Build a set of names that are not skip-directories (markers must be files
    // or non-skipped directories — a bare `.git` dir at the top of a skip list
    // should not falsely mark the parent directory as a project root)
    const markerCandidateNames = new Set(
      entries
        .filter(e => !(e.isDirectory() && SecurityFilter.shouldSkipDirectory(e.name)))
        .map(e => e.name)
    );

    // Check for project markers
    const foundMarkers = PROJECT_MARKERS.filter(marker => markerCandidateNames.has(marker));

    if (foundMarkers.length > 0) {
      results.push({
        path: dirPath,
        name: path.basename(dirPath),
        markers: foundMarkers,
      });
      // Do not recurse deeper — project is a leaf
      return;
    }

    // Recurse into subdirectories, skipping ignored and hidden ones
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (SecurityFilter.shouldSkipDirectory(entry.name)) {
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      await this.scanDirectory(path.join(dirPath, entry.name), depth + 1, results);
    }
  }
}
