import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../../logging/logger';

const logger = getLogger('PrivateCliJsonConfig');

/** A CLI JSON argument whose contents are never placed in process argv. */
export function createPrivateCliJsonConfig(json: string): {
  argument: string;
  prepare: () => () => void;
} {
  const directory = join(tmpdir(), `aio-cli-config-${randomUUID()}`);
  const file = join(directory, 'mcp.json');
  let prepared = false;
  let generation = 0;
  let currentCleanup: (() => void) | null = null;

  return {
    argument: `@${file}`,
    prepare: () => {
      if (prepared && currentCleanup) return currentCleanup;
      mkdirSync(directory, { mode: 0o700 });
      try {
        writeFileSync(file, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        prepared = true;
        const preparedGeneration = ++generation;
        currentCleanup = () => {
          if (!prepared || generation !== preparedGeneration) return;
          try {
            rmSync(directory, { recursive: true, force: true });
            prepared = false;
            currentCleanup = null;
          } catch (error) {
            logger.warn('Could not remove private CLI config', {
              code: (error as NodeJS.ErrnoException).code ?? 'unknown',
            });
          }
        };
        return currentCleanup;
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
