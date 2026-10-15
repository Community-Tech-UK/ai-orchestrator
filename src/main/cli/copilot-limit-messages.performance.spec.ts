import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Copilot limit notice matching performance', () => {
  it('rejects repeated reset prefixes without blocking on overlapping regex partitions', () => {
    // Run the actual detector in a killable child: a regex regression must not
    // hang the test worker, whose timer cannot interrupt synchronous matching.
    const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', String.raw`
      const { matchCopilotLimitNotice, COPILOT_LIMIT_WHOLE_SOURCES } = require(process.argv[1]);
      const start = performance.now();
      const rejected = [30, 100, 1000].map((count) => {
        const text = 'You have hit your rate limit.' + ' Your limit resets x'.repeat(count) + '. Extra words';
        return matchCopilotLimitNotice(text) === null
          && matchCopilotLimitNotice(text, { whole: true }) === null
          && COPILOT_LIMIT_WHOLE_SOURCES.every((source) => !new RegExp('^' + source + '$', 'iu').test(text));
      });
      const appended = matchCopilotLimitNotice('Useful report.\n'.repeat(1000) + 'You have hit your rate limit.');
      console.log(JSON.stringify({ rejected, appendedKind: appended?.kind, elapsedMs: performance.now() - start }));
    `, resolve(process.cwd(), 'src/main/cli/copilot-limit-messages.ts')], {
      encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL',
    });

    expect(child.error, 'detector must finish before the child timeout').toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as { rejected: boolean[]; appendedKind: string; elapsedMs: number };
    expect(result.rejected).toEqual([true, true, true]);
    expect(result.appendedKind).toBe('rate');
    expect(result.elapsedMs).toBeLessThan(1000);
  }, 10_000);
});
