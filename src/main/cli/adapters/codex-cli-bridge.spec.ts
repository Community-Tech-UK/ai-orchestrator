import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexCliAdapter } from './codex-cli-adapter';

class InspectableCodexAdapter extends CodexCliAdapter {
  prepare(kind: 'app-server' | 'exec'): string {
    this.prepareCodexHome(kind);
    return this.getConfig().env!['CODEX_HOME']!;
  }
  release(): void { this.cleanupCodexHome(); }
}

const bridge = {
  AIO_MCP: 'PLACEHOLDER_BINARY',
  AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: 'PLACEHOLDER_SOCKET',
  AI_ORCHESTRATOR_INSTANCE_ID: 'PLACEHOLDER_INSTANCE',
  AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: 'PLACEHOLDER_CAPABILITY',
};

describe('Codex adapter current-spawn shell bridge', () => {
  let directory: string;
  const adapters: InspectableCodexAdapter[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-bridge-adapter-'));
    mkdirSync(join(directory, '.codex'));
    writeFileSync(join(directory, '.codex', 'config.toml'), '[shell_environment_policy]\ninherit = "core"\n');
    vi.stubEnv('HOME', directory);
  });
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.release();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['app-server', 'exec'] as const)('prepares a private bridge for %s initial and native resume adapters', (kind) => {
    for (const resume of [false, true]) {
      const adapter = new InspectableCodexAdapter({ env: bridge, resume, sessionId: 'PLACEHOLDER_SESSION' });
      adapters.push(adapter);
      const home = adapter.prepare(kind);
      const config = readFileSync(join(home, 'config.toml'), 'utf-8');
      expect(config).toContain('inherit = "core"');
      for (const [key, value] of Object.entries(bridge)) expect(config).toContain(`${key} = "${value}"`);
      adapter.release();
      expect(existsSync(home)).toBe(false);
    }
  });

  it('honours explicitly removed environment variables instead of reinserting their bridge', () => {
    const adapter = new InspectableCodexAdapter({ env: bridge, envRemove: ['AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY'] });
    adapters.push(adapter);
    const home = adapter.prepare('app-server');
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).not.toContain('PLACEHOLDER_CAPABILITY');
  });

  it('does not copy an ambient bridge into a differently configured adapter', () => {
    for (const [key, value] of Object.entries(bridge)) vi.stubEnv(key, value);
    const adapter = new InspectableCodexAdapter({ env: { UNRELATED_VALUE: 'PLACEHOLDER_UNRELATED' } });
    adapters.push(adapter);
    const home = adapter.prepare('exec');
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).not.toContain('PLACEHOLDER_CAPABILITY');
  });
});
