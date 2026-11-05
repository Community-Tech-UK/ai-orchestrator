/**
 * The files a repository's pre-commit hook rebuilds on every commit, so a root
 * copy that differs from the landing is derived data, not James's own work.
 *
 * The repository names them in `scripts/generated-artifacts.json`, the same
 * file its hook reads (`scripts/run-git-hook.js`); this module never keeps a
 * second copy of the list. A repository without that file gets no special
 * handling. Only the files listed at BOTH the base and the landing tip count,
 * so a path the landing newly lists, or stops listing, is still treated as
 * hand-written.
 */
import { z } from 'zod';
import { buildCliEnv } from '../cli/cli-environment';
import { getLogger } from '../logging/logger';
import { gitExec, gitExecSafe } from '../workspace/git/git-exec';
import { runInProcessGroup } from './plan-queue-process';

const logger = getLogger('PlanQueueGeneratedFiles');

export const GENERATED_ARTIFACTS_FILE = 'scripts/generated-artifacts.json';
const GENERATE_TIMEOUT_MS = 2 * 60_000;
const OUTPUT_TAIL = 4_000;

const safePath = z.string().min(1).refine(
  (value) => !value.startsWith('/') && !value.includes('\0') && !/(^|[\\/])\.\.([\\/]|$)/.test(value) && !/^[a-zA-Z]:/.test(value),
  'must be a relative path inside the repository',
);
const ListSchema = z.object({
  artifacts: z.array(safePath).min(1),
  generators: z.array(z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/)),
});

/** Statuses of a tracked-or-new generated file Harness can set aside and put back: unstaged, staged, both, or untracked. */
export const GENERATED_STATUSES: readonly string[] = [' M', 'M ', 'MM', '??'];

export interface GeneratedFiles {
  artifacts: ReadonlySet<string>;
  /** npm script names, in the order the hook runs them, as the landing tip defines them. */
  generators: readonly string[];
}

async function readList(repoRoot: string, tip: string): Promise<z.infer<typeof ListSchema> | null> {
  if (!await gitExecSafe(['ls-tree', tip, '--', GENERATED_ARTIFACTS_FILE], repoRoot)) return null;
  const content = await gitExec(['show', `${tip}:${GENERATED_ARTIFACTS_FILE}`], repoRoot);
  const parsed = ListSchema.safeParse(JSON.parse(content));
  if (!parsed.success) throw new Error(`${GENERATED_ARTIFACTS_FILE} is not a valid list of generated files.`);
  return parsed.data;
}

/** Null when either tip has no list, so nothing is treated as generated. */
export async function loadGeneratedFiles(repoRoot: string, baseTip: string, integrationTip: string): Promise<GeneratedFiles | null> {
  const [base, landing] = await Promise.all([readList(repoRoot, baseTip), readList(repoRoot, integrationTip)]);
  if (!base || !landing) return null;
  const inBase = new Set(base.artifacts);
  return { artifacts: new Set(landing.artifacts.filter((file) => inBase.has(file))), generators: landing.generators };
}

/**
 * Rebuild the generated files in the root with the repository's own generators.
 * A failure leaves the committed copies in place, which are valid: the hook
 * rebuilds them at the next commit. It is logged, not thrown, because the
 * promotion has already happened.
 */
export async function regenerateGeneratedFiles(repoRoot: string, generators: readonly string[]): Promise<void> {
  for (const script of generators) {
    const result = await runInProcessGroup('npm', ['run', script], {
      cwd: repoRoot, env: buildCliEnv(), shell: process.platform === 'win32',
      timeoutMs: GENERATE_TIMEOUT_MS, outputTail: OUTPUT_TAIL, label: `\`npm run ${script}\``,
    });
    if (result.exitCode !== 0) {
      logger.warn('Generated files were not rebuilt after landing; the committed copies stay until the next commit', {
        script, timedOut: result.timedOut === true, output: result.output.slice(-1_000),
      });
      return;
    }
  }
}
