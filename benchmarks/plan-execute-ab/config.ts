import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type { LocalArmEndpoint, LocalModelKey } from './types';

function repoRootFromConfigPath(configPath: string): string {
  return resolve(dirname(resolve(configPath)), '..', '..');
}

export interface CliOptions {
  command: string;
  session?: string;
  tasks?: string[];
  arms?: string[];
  runs?: number;
  dryRun: boolean;
  includeOptional: boolean;
  configPath: string;
  wallMinutes?: number;
  turnCap?: number;
  phase: 'pilot' | 'full';
  repoId?: string;
  since?: string;
  limit?: number;
  bankPath?: string;
  taskFile?: string;
  localOnly?: boolean;
  /** Real prompt text for `speed-gate` probes (plan step 3: a real 30k-token agent prompt). */
  promptFile?: string;
}

export function readConfig(path: string): {
  repoPaths: Record<string, string>;
  resultsRoot: string;
  workRoot: string;
  modelControl?: import('./types').ModelControlConfig;
  localArms: LocalArmEndpoint[];
  wallClockMinutes: number;
  turnCap: number;
  bankPath: string;
  fLocalModelKey?: LocalModelKey;
  frozenPlansOnly?: boolean;
} {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const root = repoRootFromConfigPath(path);
  const rooted = (value: string | undefined, fallback: string): string => {
    const chosen = value ?? fallback;
    return chosen.startsWith('/') ? chosen : resolve(root, chosen);
  };
  // Relative repo paths resolve against the checkout that carries this config
  // (LT-709): `.` is "the checkout the benchmark runs from", so workspaces link
  // ITS node_modules — the install that matches the branch manifests — and can
  // never silently pick up a foreign checkout's divergent install.
  const rawRepoPaths = (raw['repoPaths'] as Record<string, string>) ?? {};
  const repoPaths = Object.fromEntries(
    Object.entries(rawRepoPaths).map(([repoId, value]) => [repoId, rooted(value, value)]),
  );
  return {
    repoPaths,
    resultsRoot: rooted(raw['resultsRoot'] as string | undefined, '_scratch/plan-execute-ab'),
    workRoot: rooted(raw['workRoot'] as string | undefined, '_scratch/plan-execute-ab/workspaces'),
    modelControl: raw['modelControl'] as import('./types').ModelControlConfig | undefined,
    localArms: (raw['localArms'] as LocalArmEndpoint[]) ?? [],
    wallClockMinutes: (raw['wallClockMinutes'] as number) ?? 60,
    turnCap: (raw['turnCap'] as number) ?? 75,
    bankPath: rooted(raw['bankPath'] as string | undefined, 'benchmarks/plan-execute-ab/tasks/task-bank.json'),
    fLocalModelKey: raw['fLocalModelKey'] as LocalModelKey | undefined,
  };
}

