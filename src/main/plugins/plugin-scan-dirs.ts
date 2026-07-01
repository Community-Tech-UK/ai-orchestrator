import * as path from 'path';
import { resolveProjectScanRoots } from '../util/project-scan-roots';

export interface PluginScanDir {
  readonly dir: string;
  readonly scope: 'user' | 'project';
  readonly projectRoot?: string;
}

export function resolvePluginScanDirs(
  workingDirectory: string,
  homeDir: string | null,
): PluginScanDir[] {
  const dirs: PluginScanDir[] = [];
  const seen = new Set<string>();
  const push = (scanDir: PluginScanDir): void => {
    const resolved = path.resolve(scanDir.dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push({ ...scanDir, dir: resolved });
  };

  if (homeDir) {
    push({ dir: path.join(homeDir, '.orchestrator', 'plugins'), scope: 'user' });
  }
  for (const root of resolveProjectScanRoots(workingDirectory, homeDir)) {
    push({ dir: path.join(root, '.orchestrator', 'plugins'), scope: 'project', projectRoot: root });
  }
  return dirs;
}
