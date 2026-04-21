import * as crypto from 'crypto';
import * as path from 'path';
import { app } from 'electron';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

export class ProjectStoragePaths {
  getUserDataRoot(): string {
    return app.getPath('userData');
  }

  getGlobalDomainRoot(domain: string): string {
    return path.join(this.getUserDataRoot(), domain);
  }

  getProjectsRoot(): string {
    return path.join(this.getUserDataRoot(), 'projects');
  }

  getProjectRoot(workingDirectory: string): string {
    const normalized = path.resolve(workingDirectory);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
    const label = slugify(path.basename(normalized));
    return path.join(this.getProjectsRoot(), `${label}-${hash}`);
  }

  getSessionEventLogPath(workingDirectory: string, instanceId: string): string {
    return path.join(this.getProjectRoot(workingDirectory), 'session-events', `${instanceId}.jsonl`);
  }

  getCheckpointRoot(workingDirectory: string): string {
    return path.join(this.getProjectRoot(workingDirectory), 'checkpoints');
  }

  getShadowGitRoot(workingDirectory: string): string {
    return path.join(this.getCheckpointRoot(workingDirectory), 'shadow-repo');
  }

  getAgentTreeRoot(workingDirectory: string): string {
    return path.join(this.getProjectRoot(workingDirectory), 'agent-trees');
  }
}

let storagePaths: ProjectStoragePaths | null = null;

export function getProjectStoragePaths(): ProjectStoragePaths {
  if (!storagePaths) {
    storagePaths = new ProjectStoragePaths();
  }
  return storagePaths;
}

export function _resetProjectStoragePathsForTesting(): void {
  storagePaths = null;
}
