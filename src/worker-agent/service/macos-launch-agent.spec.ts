import { describe, expect, it } from 'vitest';
import { generateLaunchAgentPlist, launchAgentPlistPath } from './macos-launch-agent';

describe('macOS LaunchAgent', () => {
  it('runs the worker in the logged-in session, restarting it after a failed exit', () => {
    const plist = generateLaunchAgentPlist({
      programArguments: ['/usr/local/bin/node', '/Users/a&b/checkout/dist/worker-agent/index.js', '--supervise'],
      workingDirectory: '/Users/a&b/checkout',
      path: '/opt/homebrew/bin:/usr/bin:/bin',
      logDir: '/Users/a&b/.orchestrator/logs',
    });

    expect(plist).toContain('<string>com.aiorchestrator.worker.user</string>');
    expect(plist).toContain('<string>/Users/a&amp;b/checkout/dist/worker-agent/index.js</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>');
    expect(plist).toContain('<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>');
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>');
    expect(plist).toContain('<string>/Users/a&amp;b/.orchestrator/logs/launchagent.err.log</string>');
    expect(plist).not.toContain('UserName');
  });

  it('lives in the user\'s LaunchAgents folder', () => {
    expect(launchAgentPlistPath('/Users/suas')).toBe('/Users/suas/Library/LaunchAgents/com.aiorchestrator.worker.user.plist');
  });
});
