import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { checkHarness, launchAgentPlist } = require('./reopen-harness.js') as {
  checkHarness: (input: { appPath: string; pausePath: string; exists: (path: string) => boolean; processPaths: () => string; reopen: (path: string) => void; sourceUpdates: () => 'ready' | 'busy' | 'blocked' }) => string;
  launchAgentPlist: (node: string, script: string) => string;
};
const appPath = '/Users/operator/Applications/Harness.app';
const pausePath = '/Users/operator/.orchestrator/home-base-reopen.paused';
function input(processes = '') {
  return { appPath, pausePath, exists: (path: string): boolean => path === appPath, processPaths: () => processes, reopen: vi.fn(), sourceUpdates: vi.fn<() => 'ready' | 'busy' | 'blocked'>(() => 'ready') };
}
describe('home base crash reopen', () => {
  it('reopens only the installed app path when only a test copy is running', () => {
    const deps = input('/tmp/live-test/Harness.app/Contents/MacOS/Harness');
    expect(checkHarness(deps)).toBe('reopened');
    expect(deps.reopen).toHaveBeenCalledWith(appPath);
  });
  it('leaves an existing home base process alone even if it is hung', () => {
    const deps = input(appPath + '/Contents/MacOS/Harness');
    expect(checkHarness(deps)).toBe('running');
    expect(deps.reopen).not.toHaveBeenCalled();
  });
  it('honours deliberate-quit pause and never opens a missing installation', () => {
    const deps = input();
    deps.exists = () => true;
    expect(checkHarness(deps)).toBe('paused');
    deps.exists = () => false;
    expect(checkHarness(deps)).toBe('not-installed');
    expect(deps.reopen).not.toHaveBeenCalled();
  });
  it('does not interpret a failed process probe as a missing process', () => {
    const deps = input();
    deps.processPaths = () => { throw new Error('process probe failed'); };
    expect(() => checkHarness(deps)).toThrow('process probe failed');
    expect(deps.reopen).not.toHaveBeenCalled();
  });
  it('uses the exact script and node paths, XML-escaped, every five minutes', () => {
    const plist = launchAgentPlist('/node&bin', '/home/a<b/reopen-harness.js');
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('<string>/node&amp;bin</string>');
    expect(plist).toContain('<string>/home/a&lt;b/reopen-harness.js</string>');
  });
  it('recovers a swap before checking whether the installed app exists', () => {
    const deps = input();
    let recovered = false;
    deps.exists = location => location === appPath && recovered;
    deps.sourceUpdates.mockImplementation(() => { recovered = true; return 'ready'; });
    expect(checkHarness(deps)).toBe('reopened');
    expect(deps.reopen).toHaveBeenCalledWith(appPath);
  });
  it.each(['busy', 'blocked'] as const)('does not launch while source updates report %s', status => {
    const deps = input();
    deps.sourceUpdates.mockReturnValue(status);
    expect(checkHarness(deps)).toBe(status === 'busy' ? 'updating' : 'source-update-failed');
    expect(deps.reopen).not.toHaveBeenCalled();
  });
  it('does not perform update recovery during an operator pause', () => {
    const deps = input();
    deps.exists = () => true;
    expect(checkHarness(deps)).toBe('paused');
    expect(deps.sourceUpdates).not.toHaveBeenCalled();
  });
});
