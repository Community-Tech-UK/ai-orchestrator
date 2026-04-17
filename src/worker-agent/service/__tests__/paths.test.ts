import { describe, it, expect } from 'vitest';
import { servicePaths } from '../paths';

describe('servicePaths', () => {
  it('returns windows paths on win32', () => {
    const p = servicePaths('win32');
    expect(p.configDir).toBe('C:\\ProgramData\\Orchestrator');
    expect(p.configFile).toBe('C:\\ProgramData\\Orchestrator\\worker-node.json');
    expect(p.binDir).toBe('C:\\Program Files\\Orchestrator\\bin');
    expect(p.logDir).toBe('C:\\ProgramData\\Orchestrator\\logs');
  });

  it('returns linux paths', () => {
    const p = servicePaths('linux');
    expect(p.configDir).toBe('/etc/orchestrator');
    expect(p.binDir).toBe('/opt/orchestrator/bin');
    expect(p.logDir).toBe('/var/log/orchestrator');
  });

  it('returns macos paths', () => {
    const p = servicePaths('darwin');
    expect(p.configDir).toBe('/Library/Application Support/Orchestrator');
    expect(p.binDir).toBe('/usr/local/opt/orchestrator/bin');
    expect(p.logDir).toBe('/Library/Logs/Orchestrator');
  });
});
