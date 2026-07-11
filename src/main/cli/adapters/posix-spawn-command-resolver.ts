import { resolveCommandOnPath } from '../cli-path-resolver';

/** Resolves and memoizes bare POSIX commands against the augmented CLI PATH. */
export class PosixSpawnCommandResolver {
  private readonly cache = new Map<string, string>();

  resolve(command: string, env?: NodeJS.ProcessEnv): string {
    if (command.includes('/')) return command;
    const cached = this.cache.get(command);
    if (cached !== undefined) return cached;

    let resolved = command;
    try {
      resolved = resolveCommandOnPath(command, env ?? process.env) ?? command;
    } catch {
      // Resolution is best-effort; preserve the pre-resolution spawn behavior.
    }
    this.cache.set(command, resolved);
    return resolved;
  }
}
