/**
 * D6 (#7) part 2 — canonical command matcher tests.
 *
 * The matcher grades an agent's CLAIMED verify command against the configured
 * `completion.verifyCommand`: equivalent invocations are 'full', narrowed runs
 * (single file / -k filter) are 'targeted', anything else is 'unrelated'.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalizeCommandSegment,
  matchClaimedVerifyCommand,
  splitCommandSegments,
} from './loop-canonical-command';

describe('splitCommandSegments', () => {
  it('splits on &&, ;, and ||', () => {
    expect(splitCommandSegments('a && b; c || d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops empty segments', () => {
    expect(splitCommandSegments(' && npm test ; ')).toEqual(['npm test']);
  });
});

describe('canonicalizeCommandSegment', () => {
  it.each([
    ['python -m pytest', ['pytest']],
    ['python3 -m pytest -q', ['pytest', '-q']],
    ['uv run pytest', ['pytest']],
    ['uv run python -m pytest', ['pytest']],
    ['poetry run pytest', ['pytest']],
    ['bundle exec rspec', ['rspec']],
    ['env CI=1 time pytest', ['pytest']],
    ['FOO=1 BAR=2 pytest', ['pytest']],
    ['npx vitest', ['vitest']],
    ['npx --yes vitest', ['vitest']],
    ['./node_modules/.bin/vitest', ['vitest']],
    ['npm test', ['npm', 'run', 'test']],
    ['npm t', ['npm', 'run', 'test']],
    ['yarn test', ['yarn', 'run', 'test']],
    ['npm run test -- --grep login', ['npm', 'run', 'test', '--grep', 'login']],
  ])('canonicalizes %j → %j', (input, expected) => {
    expect(canonicalizeCommandSegment(input)).toEqual(expected);
  });
});

describe('matchClaimedVerifyCommand — full equivalence', () => {
  it.each([
    ['pytest', 'pytest'],
    ['python -m pytest', 'pytest'],
    ['uv run pytest', 'pytest'],
    ['env CI=1 time pytest', 'pytest'],
    ['npm test', 'npm run test'],
    ['npm run test', 'npm test'],
    ['npm run lint && npm test', 'npm test'],
    ['npm run lint; npm run test', 'npm run lint && npm run test'],
    ['vitest run', 'vitest'],
    ['pytest -q', 'pytest'],
    ['npx vitest', 'vitest'],
  ])('claimed %j fully matches configured %j', (claimed, configured) => {
    expect(matchClaimedVerifyCommand(claimed, configured)).toBe('full');
  });
});

describe('matchClaimedVerifyCommand — targeted narrowing (cannot masquerade as repo-green)', () => {
  it.each([
    ['pytest tests/test_login.py', 'pytest'],
    ['pytest -k login', 'pytest'],
    ['npm run test -- --grep login', 'npm run test'],
    ['vitest run src/x.spec.ts', 'vitest'],
    // Compound: lint fully matched, but the test half is a single file.
    ['npm run lint && pytest tests/test_x.py', 'npm run lint && pytest'],
    // A cd re-scopes later segments to a subdirectory — not the root suite.
    ['cd packages/x && npm test', 'npm run test'],
    ['cd sub; pytest', 'pytest'],
    // npm --prefix runs a sub-package's suite, not the configured root one.
    ['npm --prefix packages/x run test', 'npm run test'],
  ])('claimed %j is targeted vs configured %j', (claimed, configured) => {
    expect(matchClaimedVerifyCommand(claimed, configured)).toBe('targeted');
  });

  it('a cd BEFORE the match narrows it, a cd AFTER does not', () => {
    expect(matchClaimedVerifyCommand('npm test && cd docs && ls', 'npm run test')).toBe('full');
  });
});

describe('matchClaimedVerifyCommand — unrelated', () => {
  it.each([
    ['npm run lint', 'npm run test'],
    ['grep -r foo src/', 'pytest'],
    // One configured segment has no counterpart at all.
    ['pytest', 'npm run lint && pytest'],
    // Claimed runs LESS than configured (missing the configured path scope).
    ['pytest', 'pytest tests/'],
    ['', 'pytest'],
    ['pytest', ''],
  ])('claimed %j is unrelated to configured %j', (claimed, configured) => {
    expect(matchClaimedVerifyCommand(claimed, configured)).toBe('unrelated');
  });
});
