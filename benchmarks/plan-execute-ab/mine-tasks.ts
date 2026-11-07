import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { cleanupWorkspace, exportWorkspace, applyHiddenTests } from './task-export';
import { prepareScoringDependencies } from './scoring-setup';
import { isSolved, scoreRun } from './scorer';
import type { ScoreBundle, TaskDefinition, TaskSize, TaskVerification } from './types';

const TEST_FILE_PATTERN = /(\.spec\.|\.test\.|__tests__\/|\/tests?\/|test_[^/]+\.py|[^/]+_test\.php|Tests?\.java$)/i;

export interface MiningCandidate {
  commitSha: string;
  parentSha: string;
  commitMessage: string;
  testFiles: string[];
  sourceFiles: string[];
  size: TaskSize;
}

export interface RepoMiningOptions {
  repoPath: string;
  repoId: string;
  /** ISO date; only commits after this are considered. */
  since?: string;
  limit?: number;
}

export function classifySize(sourceFiles: string[]): TaskSize {
  if (sourceFiles.length <= 1) return 'small';
  if (sourceFiles.length <= 5) return 'medium';
  return 'large';
}

export function listCandidates(options: RepoMiningOptions): MiningCandidate[] {
  const repoPath = resolve(options.repoPath);
  const args = ['-C', repoPath, 'log', '--no-merges', '--format=%x1e%H%x1f%P%x1f%s', '--name-only'];
  if (options.since) args.push(`--since=${options.since}`);
  const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const candidates: MiningCandidate[] = [];
  let current: MiningCandidate | null = null;
  const pushCurrent = (): void => {
    if (current && current.testFiles.length > 0 && current.sourceFiles.length > 0) {
      current.size = classifySize(current.sourceFiles);
      candidates.push(current);
    }
  };
  for (const rawLine of out.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('\x1e')) {
      pushCurrent();
      if (options.limit && candidates.length >= options.limit) return candidates;
      const header = line.slice(1).split('\x1f');
      const commitSha = header[0] ?? '';
      const parentSha = (header[1] ?? '').split(' ')[0] ?? '';
      const commitMessage = header.slice(2).join('\x1f');
      current = commitSha && parentSha
        ? {
            commitSha,
            parentSha,
            commitMessage,
            testFiles: [],
            sourceFiles: [],
            size: 'small',
          }
        : null;
      continue;
    }
    if (!current || !line.trim()) continue;
    const file = line.trim();
    if (TEST_FILE_PATTERN.test(file)) {
      current.testFiles.push(file);
    } else if (/\.(ts|tsx|js|jsx|mjs|py|php|java)$/.test(file)) {
      current.sourceFiles.push(file);
    }
  }
  pushCurrent();
  return candidates;
}

export function draftPrompt(candidate: MiningCandidate): string {
  const subject = candidate.commitMessage.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').replace(/^v?[\d.]+:?\s*/i, '');
  const trimmed = subject.trim().replace(/\.$/, '');
  return [
    `Task: ${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`,
    '',
    'Implement the change so the described behaviour works and is covered by tests. Keep the change focused: no unrelated refactors.',
  ].join('\n');
}

export interface LeakageContext {
  commitSha: string;
  parentSha: string;
  commitMessage: string;
  testFiles: string[];
  sourceFiles: string[];
  patchLines?: string[];
}

export function leakageCheck(prompt: string, context: LeakageContext): string[] {
  const issues: string[] = [];
  if (prompt.includes(context.commitSha) || prompt.includes(context.parentSha)) {
    issues.push('prompt contains a commit sha');
  }
  for (const file of [...context.testFiles, ...context.sourceFiles]) {
    if (prompt.includes(file)) issues.push(`prompt names a changed file (${file})`);
  }
  const messageWords = context.commitMessage.toLowerCase().split(/\s+/).filter((w) => w.length > 6);
  const promptLower = prompt.toLowerCase();
  let quoted = 0;
  for (const word of messageWords) {
    if (promptLower.includes(word)) quoted += 1;
  }
  if (messageWords.length > 0 && quoted / messageWords.length > 0.6) {
    issues.push('prompt closely quotes the commit message');
  }
  for (const line of context.patchLines ?? []) {
    const added = line.replace(/^[+-]/, '').trim();
    if (added.length > 30 && prompt.includes(added)) {
      issues.push('prompt quotes a line from the diff');
    }
    if (issues.length > 5) break;
  }
  return issues;
}

export interface VerificationOptions {
  task: TaskDefinition;
  repoPath: string;
  evidenceDir: string;
  workRoot: string;
  timeoutMs?: number;
}

export interface VerificationResult {
  failOnParent: boolean;
  passOnCommit: boolean;
  parentExit: number | null;
  commitExit: number | null;
  evidenceDir: string;
  log: string[];
  parentScore: ScoreBundle;
  commitScore: ScoreBundle;
}

/**
 * Fail-on-parent / pass-on-commit: the commit's own tests, copied onto the
 * parent tree, must fail; the same tests on the commit must pass.
 */
export async function verifyTask(options: VerificationOptions): Promise<VerificationResult> {
  const log: string[] = [];
  mkdirSync(options.evidenceDir, { recursive: true });
  const workspaceName = `${options.task.id}-verification`;
  const dir = join(resolve(options.workRoot), workspaceName);
  const evaluate = async (phase: 'parent' | 'commit', sha: string): Promise<ScoreBundle> => {
    const existed = existsSync(dir);
    try {
      const workspace = await exportWorkspace({ repoPath: options.repoPath, commitSha: sha, workRoot: options.workRoot, workspaceName });
      const logDir = join(options.evidenceDir, phase);
      const dependencies = await prepareScoringDependencies(workspace.dir, logDir);
      applyHiddenTests(options.repoPath, options.task.commitSha, options.task.hiddenTests, workspace.dir);
      // Parent verification establishes the intended hidden failure. The fixed
      // revision must also satisfy the same damage checks as an actual run.
      const task = phase === 'parent' ? { ...options.task, damageCommands: [] } : options.task;
      const score = await scoreRun(task, { workspaceDir: workspace.dir, timeoutMs: options.timeoutMs, logDir, dependencies });
      log.push(`${phase} hidden exit ${score.hiddenTests.exitCode}; damageOk ${score.damageOk}`);
      return score;
    } finally {
      if (!existed) cleanupWorkspace(dir);
    }
  };
  const parentScore = await evaluate('parent', options.task.parentSha);
  const commitScore = await evaluate('commit', options.task.commitSha);

  const result: VerificationResult = {
    failOnParent: !parentScore.hiddenTests.passed && !parentScore.hiddenTests.timedOut,
    passOnCommit: isSolved(commitScore),
    parentExit: parentScore.hiddenTests.exitCode,
    commitExit: commitScore.hiddenTests.exitCode,
    evidenceDir: options.evidenceDir,
    log,
    parentScore,
    commitScore,
  };
  writeFileSync(join(options.evidenceDir, 'verification.json'), JSON.stringify(result, null, 2));
  return result;
}

export function buildVerifiedTask(
  candidate: MiningCandidate,
  repoId: string,
  prompt: string,
  hiddenTestCommand: string[],
  damageCommands: string[][],
  verification: TaskVerification,
  taskId: string,
): TaskDefinition {
  return {
    id: taskId,
    repoId,
    commitSha: candidate.commitSha,
    parentSha: candidate.parentSha,
    commitMessage: candidate.commitMessage,
    size: candidate.size,
    prompt,
    hiddenTests: candidate.testFiles,
    hiddenTestCommand,
    damageCommands,
    sourceFiles: candidate.sourceFiles,
    verification,
  };
}
