import { execFile } from 'child_process';
import { promisify } from 'util';
import { formatReviewJson, type HeadlessReviewResult } from './review-command-output';
import { getCrossModelReviewService } from '../orchestration/cross-model-review-service';
import { ProviderReviewExecutionHost, type HeadlessReviewRequest } from '../review/review-execution-host';
import { resolveGitHostMetadata } from '../vcs/remotes/git-host-connector';

const execFileAsync = promisify(execFile);

export interface ParsedReviewCommandArgs {
  cwd: string;
  target: string;
  json: boolean;
  reviewers?: string[];
}

export interface ResolvedReviewTarget {
  target: string;
  cwd: string;
  content: string;
  taskDescription: string;
}

interface GitHostMetadataForReview {
  title: string;
  description?: string;
  baseBranch?: string;
  headBranch?: string;
}

export interface ReviewCommandDeps {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  runGit?: (cwd: string, args: string[]) => Promise<string>;
  resolveGitHostMetadata?: (url: string, cwd: string) => Promise<GitHostMetadataForReview | null>;
  runHeadlessReview?: (request: HeadlessReviewRequest) => Promise<HeadlessReviewResult>;
}

export function parseReviewCommandArgs(argv: string[]): ParsedReviewCommandArgs {
  let cwd = process.cwd();
  let target = '';
  let json = false;
  let reviewers: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--cwd') {
      cwd = requireValue(argv, index, '--cwd');
      index += 1;
      continue;
    }
    if (arg === '--target') {
      target = requireValue(argv, index, '--target');
      index += 1;
      continue;
    }
    if (arg === '--reviewer' || arg === '--reviewers') {
      const value = requireValue(argv, index, arg);
      reviewers = value === 'none'
        ? []
        : value.split(',').map((item) => item.trim()).filter(Boolean);
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown review option: ${arg}`);
    }
    if (!target) {
      target = arg;
      continue;
    }
    throw new Error(`Unexpected review argument: ${arg}`);
  }

  return {
    cwd,
    target: target || 'HEAD',
    json,
    ...(reviewers ? { reviewers } : {}),
  };
}

export async function resolveReviewCommandTarget(
  args: ParsedReviewCommandArgs,
  deps: Pick<ReviewCommandDeps, 'runGit' | 'resolveGitHostMetadata'> = {},
): Promise<ResolvedReviewTarget> {
  const runGit = deps.runGit ?? runGitCommand;
  const metadataResolver = deps.resolveGitHostMetadata ?? resolveGitHostMetadata;

  if (isHttpUrl(args.target)) {
    const metadata = await metadataResolver(args.target, args.cwd).catch(() => null);
    if (metadata?.baseBranch && metadata.headBranch) {
      const diffTarget = `${metadata.baseBranch}...${metadata.headBranch}`;
      const diff = await collectGitDiff(args.cwd, diffTarget, runGit).catch((error) =>
        `Git diff target: ${diffTarget}\n\nUnable to collect local diff: ${(error as Error).message}`,
      );
      return {
        target: args.target,
        cwd: args.cwd,
        content: [
          `Pull request URL: ${args.target}`,
          `Local diff target: ${diffTarget}`,
          diff,
        ].join('\n\n'),
        taskDescription: [
          `Review pull request: ${metadata.title}`,
          metadata.description ? `\n${metadata.description}` : '',
        ].join(''),
      };
    }

    return {
      target: args.target,
      cwd: args.cwd,
      content: `Pull request URL: ${args.target}`,
      taskDescription: `Review pull request ${args.target}`,
    };
  }

  return {
    target: args.target,
    cwd: args.cwd,
    content: await collectGitDiff(args.cwd, args.target, runGit),
    taskDescription: `Review local diff target ${args.target}`,
  };
}

export async function runReviewCommand(
  argv: string[],
  deps: ReviewCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const startedAt = new Date();
  let parsed: ParsedReviewCommandArgs | null = null;

  try {
    parsed = parseReviewCommandArgs(argv);
    const target = await resolveReviewCommandTarget(parsed, deps);
    const runHeadlessReview = deps.runHeadlessReview ?? defaultRunHeadlessReview;
    const result = await runHeadlessReview({
      target: target.target,
      cwd: target.cwd,
      content: target.content,
      taskDescription: target.taskDescription,
      reviewers: parsed.reviewers,
    });

    stdout(parsed.json ? formatReviewJson(result) : `${result.summary}\n`);
    return result.infrastructureErrors.length > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: HeadlessReviewResult = {
      target: parsed?.target ?? '',
      cwd: parsed?.cwd ?? process.cwd(),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      reviewers: [],
      findings: [],
      summary: message,
      infrastructureErrors: [message],
    };
    if (parsed?.json ?? argv.includes('--json')) {
      stdout(formatReviewJson(result));
    } else {
      stderr(`${message}\n`);
    }
    return 1;
  }
}

async function defaultRunHeadlessReview(request: HeadlessReviewRequest): Promise<HeadlessReviewResult> {
  const service = getCrossModelReviewService();
  service.setReviewExecutionHost(new ProviderReviewExecutionHost());
  return service.runHeadlessReview(request);
}

async function collectGitDiff(
  cwd: string,
  target: string,
  runGit: (cwd: string, args: string[]) => Promise<string>,
): Promise<string> {
  const stat = await runGit(cwd, ['diff', '--stat', target]);
  const diff = await runGit(cwd, ['diff', '--find-renames', target]);
  return [
    `Git diff target: ${target}`,
    stat.trim() ? `Diff stat:\n${stat.trim()}` : 'Diff stat: empty',
    diff.trim() ? `Diff:\n${diff.trim()}` : 'Diff: empty',
  ].join('\n\n');
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

if (require.main === module) {
  runReviewCommand(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
