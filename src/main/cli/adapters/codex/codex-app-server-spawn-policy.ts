/**
 * AIO-owned Codex app-server spawn policy.
 *
 * Isolated `codex app-server` processes get `-c tool_output_token_limit=6000`
 * so native command results cannot accumulate unbounded in the retained
 * thread. The flag is never written to `~/.codex/config.toml` and is never
 * passed to the shared broker process.
 */

export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 6000;

export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT_OVERRIDE =
  `tool_output_token_limit=${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`;

export type CodexOutputLimitState = 'applied' | 'unsupported' | 'unknown';

const FATAL_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

/**
 * argv for an AIO-owned isolated app-server (not the shared broker).
 */
export function buildIsolatedAppServerArgs(applyOutputLimit: boolean): string[] {
  if (!applyOutputLimit) {
    return ['app-server'];
  }
  return ['-c', CODEX_TOOL_OUTPUT_TOKEN_LIMIT_OVERRIDE, 'app-server'];
}

/** Retry without the override only when the CLI may have rejected `-c`. */
export function shouldRetryIsolatedAppServerWithoutOutputLimit(error: unknown): boolean {
  const err = error as { code?: string; syscall?: string; message?: string } | undefined;
  if (err?.code && FATAL_SPAWN_CODES.has(err.code)) {
    return false;
  }
  if (err?.syscall?.startsWith('spawn') && err.code && FATAL_SPAWN_CODES.has(err.code)) {
    return false;
  }
  return !/spawn .+ (ENOENT|EACCES|EPERM|ENOTDIR)/.test(String(err?.message ?? error));
}
