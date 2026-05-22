import * as path from 'path';
import type { LoopConfig } from '../../shared/types/loop.types';
import { completedPlanFileCandidates } from './loop-completion-detector';

export interface VerifyOutcomeLike {
  status: 'passed' | 'skipped' | 'failed';
  output: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function excerpt(s: string, max = 4096): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '\n…\n' + s.slice(-half);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9_\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

export function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

export function completedPlanWatchDirs(config: LoopConfig): string[] {
  return [...new Set(completedPlanFileCandidates(config).map((candidate) => path.dirname(candidate)))];
}
