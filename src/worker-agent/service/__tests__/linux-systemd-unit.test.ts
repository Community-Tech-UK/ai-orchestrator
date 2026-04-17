import { describe, it, expect } from 'vitest';
import { generateSystemdUnit } from '../linux-systemd-unit';

describe('generateSystemdUnit', () => {
  it('emits a full unit with hardening directives', () => {
    const unit = generateSystemdUnit({
      description: 'AI Orchestrator Worker',
      execStart: '/opt/orchestrator/bin/worker-agent --service-run --config /etc/orchestrator/worker-node.json',
      user: 'orchestrator',
      group: 'orchestrator',
      workingDirectory: '/var/lib/orchestrator',
      stateDirectory: 'orchestrator',
      logDirectory: 'orchestrator',
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=AI Orchestrator Worker');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('User=orchestrator');
    expect(unit).toContain('Group=orchestrator');
    expect(unit).toContain('ExecStart=/opt/orchestrator/bin/worker-agent');
    expect(unit).toContain('Restart=on-failure');
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
