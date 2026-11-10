import { describe, it, expect } from 'vitest';
import { generateSystemdUnit } from '../linux-systemd-unit';
import { generateLaunchdPlist } from '../macos-launchd-plist';
import { generateWinswXml } from '../windows-winsw-xml';

// Service definition files for the three platforms (merged from one file per generator).

describe('generateSystemdUnit', () => {
  it('emits a full unit with hardening directives', () => {
    const unit = generateSystemdUnit({
      description: 'Harness Worker',
      execStart: '/opt/orchestrator/bin/worker-agent --service-run --config /etc/orchestrator/worker-node.json',
      user: 'orchestrator',
      group: 'orchestrator',
      workingDirectory: '/var/lib/orchestrator',
      stateDirectory: 'orchestrator',
      logDirectory: 'orchestrator',
      environment: {
        GH_TOKEN: 'ghu token',
      },
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=Harness Worker');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('User=orchestrator');
    expect(unit).toContain('Group=orchestrator');
    expect(unit).toContain('ExecStart=/opt/orchestrator/bin/worker-agent');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('Environment="GH_TOKEN=ghu token"');
    expect(unit).toContain('RestartSec=10');
    expect(unit).toContain('NoNewPrivileges=yes');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ProtectHome=yes');
    expect(unit).toContain('PrivateTmp=yes');
    expect(unit).toContain('ReadOnlyPaths=/etc/orchestrator');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=multi-user.target');
  });
});

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
      environment: {
        GH_TOKEN: 'ghu_test&token',
      },
    });
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>com.aiorchestrator.worker</string>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>UserName</key>\n  <string>_orchestrator</string>');
    expect(xml).toContain('<key>StandardOutPath</key>');
    expect(xml).toContain('<key>EnvironmentVariables</key>');
    expect(xml).toContain('<key>GH_TOKEN</key>\n    <string>ghu_test&amp;token</string>');
  });
});

describe('generateWinswXml', () => {
  it('includes escaped service name, binary path, and config arg', () => {
    const xml = generateWinswXml({
      serviceId: 'ai-orchestrator-worker',
      displayName: 'Harness Worker',
      description: 'Worker node for Harness',
      executable: 'C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe',
      arguments: ['--service-run', '--config', 'C:\\ProgramData\\Orchestrator\\worker-node.json'],
      logDir: 'C:\\ProgramData\\Orchestrator\\logs',
      serviceAccount: 'NT SERVICE\\ai-orchestrator-worker',
      env: {
        COPILOT_GITHUB_TOKEN: 'ghu_test&token',
      },
    });
    expect(xml).toContain('<id>ai-orchestrator-worker</id>');
    expect(xml).toContain('<executable>C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe</executable>');
    expect(xml).toContain('<argument>--service-run</argument>');
    expect(xml).toContain('<logpath>C:\\ProgramData\\Orchestrator\\logs</logpath>');
    expect(xml).toContain('<env name="COPILOT_GITHUB_TOKEN" value="ghu_test&amp;token"/>');
    expect(xml).toContain('<serviceaccount>');
    expect(xml).toContain('<onfailure action="restart" delay="10 sec"/>');
  });

  it('escapes special XML characters in description', () => {
    const xml = generateWinswXml({
      serviceId: 'x',
      displayName: 'X',
      description: 'A & B < C > "D"',
      executable: 'C:\\x.exe',
      arguments: [],
      logDir: 'C:\\logs',
    });
    expect(xml).toContain('A &amp; B &lt; C &gt; &quot;D&quot;');
  });
});
