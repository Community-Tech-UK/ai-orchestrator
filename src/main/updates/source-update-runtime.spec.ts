import { describe, expect, it } from 'vitest';
import { usesSourceUpdates } from './source-update-runtime';

const context = {
  platform: 'darwin' as const, packaged: true, liveTest: false, hasConfig: true,
  executable: '/Users/example/Applications/Harness.app/Contents/MacOS/Harness', home: '/Users/example',
};

describe('desktop source-update opt-in', () => {
  it('selects source updates only for the configured installed Mac app', () => {
    expect(usesSourceUpdates(context)).toBe(true);
    expect(usesSourceUpdates({ ...context, hasConfig: false })).toBe(false);
    expect(usesSourceUpdates({ ...context, packaged: false })).toBe(false);
    expect(usesSourceUpdates({ ...context, platform: 'linux' })).toBe(false);
    expect(usesSourceUpdates({ ...context, liveTest: true })).toBe(false);
  });

  it('never targets a different packaged app or test copy using the same user home', () => {
    expect(usesSourceUpdates({ ...context, executable: '/tmp/test/Harness.app/Contents/MacOS/Harness' })).toBe(false);
    expect(usesSourceUpdates({ ...context, executable: '/Applications/Harness.app/Contents/MacOS/Harness' })).toBe(false);
  });
});
