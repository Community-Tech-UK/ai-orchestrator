import { describe, it, expect } from 'vitest';
import { generateLaunchdPlist } from '../macos-launchd-plist';

describe('generateLaunchdPlist', () => {
  it('emits a daemon plist with RunAtLoad, KeepAlive, and StandardOut/ErrorPath', () => {
    const xml = generateLaunchdPlist({
      label: 'com.aiorchestrator.worker',
      programArguments: [
        '/usr/local/opt/orchestrator/bin/worker-agent',
        '--service-run',
        '--config',
        '/Library/Application Support/Orchestrator/worker-node.json',
      ],
      userName: '_orchestrator',
      groupName: '_orchestrator',
      stdoutPath: '/Library/Logs/Orchestrator/worker.out.log',
      stderrPath: '/Library/Logs/Orchestrator/worker.err.log',
      workingDirectory: '/usr/local/var/orchestrator',
    });
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>com.aiorchestrator.worker</string>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>UserName</key>\n  <string>_orchestrator</string>');
    expect(xml).toContain('<key>StandardOutPath</key>');
  });
});
