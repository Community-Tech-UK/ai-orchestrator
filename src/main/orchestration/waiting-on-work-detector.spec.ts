import { describe, expect, it } from 'vitest';
import { detectWaitingOnWork } from './waiting-on-work-detector';

describe('detectWaitingOnWork', () => {
  it.each([
    "The renderer works. I'm waiting for the PC's three-at-once result and the report writer's corrections.",
    'Plan corrected. I’ll pick up again when the report writer or the sampler reports back.',
    'Two runs left. I will continue once the benchmark finishes.',
    'Now waiting on the build.',
    "I'm waiting for the build.\n\nNothing else is needed right now.",
  ])('finds %s', (reply) => {
    expect(detectWaitingOnWork(reply)).not.toBeNull();
  });

  it.each([
    "I'm waiting for your decision on the plan.",
    "I'll continue once you confirm which option you want.",
    'Waiting for James to sign in.',
    'All checks passed and the work is complete.',
    'The server is running on port 3000.',
    'Say `I am waiting for the build` in the reply.',
    'All tests pass. The watcher is still running in the background.',
    'Done. The migration ran cleanly and the build is green. The local Postgres container is still running.',
    "I'm waiting for the build. One. Two. Three. Four.",
    `I'm waiting for the build. ${'The rest of this long reply explains the result in detail. '.repeat(9).trim()}`,
  ])('ignores %s', (reply) => {
    expect(detectWaitingOnWork(reply)).toBeNull();
  });
});
