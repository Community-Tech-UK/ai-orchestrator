import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testMaxForks } from '../../vitest.pool';

/**
 * Both Vitest projects ran `singleFork: true` until 2026-08-20, which put every
 * spec file of a project through one long-lived process: retained state grew
 * until a full run died at V8's heap ceiling, and the wall clock was the sum of
 * ~1.5k files. Parallel isolated forks fixed both.
 *
 * Reintroducing `singleFork` anywhere in the config silently restores the old
 * behaviour — the suite still passes, just serially and with a growing heap —
 * so the config text is asserted here rather than left to review.
 */

const repoRoot = path.resolve(__dirname, '..', '..');

describe('test worker fan-out', () => {
  // The suite itself may be running under an AIO_TEST_MAX_FORKS pin (CI, a
  // benchmark run). Clear it so the host-sizing cases test the real arithmetic
  // instead of reading back the ambient override.
  beforeEach(() => {
    vi.stubEnv('AIO_TEST_MAX_FORKS', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves a core for the orchestrator on small hosts', () => {
    expect(testMaxForks(1, 0)).toBe(1);
    expect(testMaxForks(2, 0)).toBe(1);
    expect(testMaxForks(4, 0)).toBe(3);
  });

  it('caps fan-out well below a big host core count', () => {
    // Measured on an idle-ish 18-core host: main went 550s -> 153s at 8 forks,
    // and only 153s -> 125s at 16. The remaining cores stay available to the
    // app, other agent sessions, and any concurrent suite.
    expect(testMaxForks(18, 0)).toBe(8);
    expect(testMaxForks(96, 0)).toBe(8);
  });

  it('gives back cores the host is already using', () => {
    expect(testMaxForks(18, 6)).toBe(8); // still plenty spare -> capped
    expect(testMaxForks(18, 12)).toBe(5);
    expect(testMaxForks(18, 16)).toBe(1);
    // A saturated host degrades to serial rather than piling on.
    expect(testMaxForks(18, 467)).toBe(1);
  });

  it('honours an explicit override', () => {
    vi.stubEnv('AIO_TEST_MAX_FORKS', '3');
    expect(testMaxForks(18, 467)).toBe(3);
    vi.stubEnv('AIO_TEST_MAX_FORKS', 'not-a-number');
    expect(testMaxForks(18, 0)).toBe(8);
    vi.stubEnv('AIO_TEST_MAX_FORKS', '2.5');
    expect(testMaxForks(18, 0)).toBe(8);
    vi.stubEnv('AIO_TEST_MAX_FORKS', '-4');
    expect(testMaxForks(18, 0)).toBe(8);
    // A typo'd override is clamped rather than obeyed.
    vi.stubEnv('AIO_TEST_MAX_FORKS', '800');
    expect(testMaxForks(18, 0)).toBe(64);
  });

  it('treats a host with no load average as merely idle', () => {
    // Node reports [0, 0, 0] on Windows; that must not read as "fully free" in
    // some special way, just the plain core-count path.
    expect(testMaxForks(4, 0)).toBe(3);
    expect(testMaxForks(18, 0)).toBe(8);
  });

  it('keeps singleFork out of the default config', () => {
    const config = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
    // Anything but a literal `false` — including an indirection such as
    // `singleFork: SOME_FLAG` — counts as reintroducing it.
    expect(config).not.toMatch(/singleFork:(?!\s*false\b)/);
  });
});
