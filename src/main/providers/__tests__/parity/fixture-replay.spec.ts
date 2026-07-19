import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  replayAdapterEventFixture,
  type AdapterEventFixtureRecord,
} from '../../provider-event-fixture-replay';

const FIXTURES_DIR = join(
  process.cwd(),
  'packages/contracts/src/__fixtures__/provider-events',
);

const CASES = [
  ['claude', 'basic-conversation'],
  ['claude', 'tool-use-bash'],
  ['codex', 'basic-conversation'],
  ['codex', 'tool-use-bash'],
  // `antigravity` is the live Google-backed provider (see BuiltInProviderName in
  // packages/contracts/src/types/provider-runtime-events.ts). `gemini` is kept as a
  // deprecated back-compat fixture — persisted historical data and older remote nodes
  // may still replay it — not as live coverage.
  ['antigravity', 'basic-conversation'],
  ['gemini', 'basic-conversation'],
  ['copilot', 'basic-conversation'],
] as const;

describe('provider adapter-event fixture replay', () => {
  for (const [provider, scenario] of CASES) {
    it(`${provider}/${scenario} produces its golden canonical stream`, () => {
      const directory = join(FIXTURES_DIR, provider);
      const fixture = readJsonLines<AdapterEventFixtureRecord>(join(directory, `${scenario}.jsonl`));
      const golden = readJsonLines<unknown>(join(directory, `${scenario}.golden.jsonl`));

      expect(replayAdapterEventFixture(fixture).map(({ event }) => event)).toEqual(golden);
    });
  }
});

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
