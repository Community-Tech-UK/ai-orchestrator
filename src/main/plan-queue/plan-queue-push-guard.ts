/**
 * Plan Queue sessions never push.
 *
 * Queue sessions run without approval prompts, and only AGENTS.md told them not to push. This adds
 * three git-level blocks that hold whatever provider runs the session, through its environment:
 *   - `url.<blocked>.pushInsteadOf` for the usual remote address forms, so a push to them fails to
 *     connect instead of reaching the remote (git 2.31+ reads these from GIT_CONFIG_COUNT/KEY/VALUE);
 *   - a cleared and then blocked `remote.<name>.pushurl` for every remote that has its own push
 *     address, because pushInsteadOf does not rewrite those (covers remotes that exist when the
 *     session starts);
 *   - `AIO_QUEUE_SESSION`, which this repository's pre-push hook refuses on.
 *
 * It stops normal tool use, not an agent that deliberately clears its own environment. Known gaps:
 * scp-style forms without `git@` (`deploy@host:repo`, `host:repo`), `ftp://` and `file://`, which a
 * fixed prefix cannot cover without also blocking local paths that test fixtures push to.
 */

import { gitExec } from '../workspace/git/git-exec';

/** A scheme no git remote helper exists for, so a rewritten push fails without any network access. */
const BLOCKED_BASE = 'aio-queue-push-blocked://';
export const QUEUE_SESSION_ENV = 'AIO_QUEUE_SESSION';

const BLOCKED_PREFIXES = ['git@', 'ssh://', 'git+ssh://', 'ssh+git://', 'https://', 'http://', 'git://'] as const;

/** Names of remotes in `cwd` that set their own push address; none when it is not a repository. */
async function remotesWithPushUrl(cwd: string): Promise<string[]> {
  const output = await gitExec(['config', '--get-regexp', '^remote\\..*\\.pushurl$'], cwd).catch(() => '');
  const names = output.split('\n').flatMap((line) => /^remote\.(.+)\.pushurl\s/.exec(line)?.[1] ?? []);
  return [...new Set(names)];
}

/**
 * The environment entries for one queue session started in `cwd`. `baseEnv` is the environment the
 * session would otherwise get, so entries it already holds in GIT_CONFIG_COUNT are kept.
 */
export async function buildQueuePushGuardEnv(cwd: string, baseEnv: Readonly<Record<string, string | undefined>> = {}): Promise<Record<string, string>> {
  // The session inherits the app's own environment under `baseEnv`, so both count towards GIT_CONFIG_COUNT.
  const inherited = { ...process.env, ...baseEnv };
  const settings: Array<[string, string]> = [
    ...BLOCKED_PREFIXES.map((prefix): [string, string] => [`url.${BLOCKED_BASE}.pushInsteadOf`, prefix]),
    // An empty value clears the remote's push addresses (a pushurl list adds up), then the blocked one replaces them.
    ...(await remotesWithPushUrl(cwd)).flatMap((name): Array<[string, string]> => [[`remote.${name}.pushurl`, ''], [`remote.${name}.pushurl`, `${BLOCKED_BASE}${name}`]]),
  ];
  const existing = Number.parseInt(inherited['GIT_CONFIG_COUNT'] ?? '0', 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const env: Record<string, string> = { [QUEUE_SESSION_ENV]: '1', GIT_CONFIG_COUNT: String(start + settings.length) };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${start + index}`] = key;
    env[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  return env;
}

/** Claude's deny rules (`--disallowedTools`) for the commands that publish work. Other providers rely on the git-level blocks. */
export const QUEUE_DENIED_TOOLS: readonly string[] = [
  'Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge:*)', 'Bash(gh release create:*)',
];

interface SessionRef { metadata?: Readonly<Record<string, unknown>>; parentId?: string | null }

/**
 * True for a session the Plan Queue started (worker, checker or triage) and for any session such a
 * session started through the orchestrator tools, however deep: a child of a worker must not push either.
 */
export function isQueueSession(session: SessionRef | undefined, getSession: (id: string) => SessionRef | undefined): boolean {
  const seen = new Set<string>();
  for (let current = session; current; current = current.parentId ? getSession(current.parentId) : undefined) {
    if (typeof current.metadata?.['planQueueRole'] === 'string') return true;
    if (!current.parentId || seen.has(current.parentId)) return false;
    seen.add(current.parentId);
  }
  return false;
}
