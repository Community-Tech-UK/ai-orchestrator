import { describe, it, expect } from 'vitest';
import { generateWinswXml } from '../windows-winsw-xml';

describe('generateWinswXml', () => {
  it('includes escaped service name, binary path, and config arg', () => {
    const xml = generateWinswXml({
      serviceId: 'ai-orchestrator-worker',
      displayName: 'AI Orchestrator Worker',
      description: 'Worker node for AI Orchestrator',
      executable: 'C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe',
      arguments: ['--service-run', '--config', 'C:\\ProgramData\\Orchestrator\\worker-node.json'],
      logDir: 'C:\\ProgramData\\Orchestrator\\logs',
      serviceAccount: 'NT SERVICE\\ai-orchestrator-worker',
    });
    expect(xml).toContain('<id>ai-orchestrator-worker</id>');
    expect(xml).toContain('<executable>C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe</executable>');
    expect(xml).toContain('<argument>--service-run</argument>');
    expect(xml).toContain('<logpath>C:\\ProgramData\\Orchestrator\\logs</logpath>');
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
