import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { McpSecretStorage } from './secret-storage';
import { OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import { OrchestratorInjectionReader } from './orchestrator-injection-reader';
import { connectorAccessRegistry } from './connector-access';
const dbs: SqliteDriver[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  connectorAccessRegistry.clear();
});
describe('connector spawn materialization', () => {
  it('gives all supported providers a credential-free stdio forwarder', () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    const repo = new OrchestratorMcpRepository(
      db,
      new McpSecretStorage({ safeStorage: { isEncryptionAvailable: () => false } }),
    );
    const saved = repo.upsert({
      name: 'remote-example',
      transport: 'http',
      url: 'https://example.test/mcp',
      authType: 'oauth',
    });
    repo.upsert({ name: 'disabled', transport: 'stdio', command: 'node', autoConnect: false });
    const reader = new OrchestratorInjectionReader(repo, () => ({
      command: 'aio-mcp',
      socketPath: 'PLACEHOLDER_SOCKET',
      capabilityToken: 'PLACEHOLDER_CAPABILITY',
    }));
    for (const provider of [
      'claude',
      'codex',
      'gemini',
      'copilot',
      'cursor',
      'grok',
      'opencode',
    ] as const) {
      const result = reader.buildBundle(provider, provider);
      expect(result.inlineConfigs).toHaveLength(1);
      const content = result.inlineConfigs[0];
      expect(content).not.toContain('https://example.test');
      expect(JSON.parse(content).mcpServers['remote-example']).toMatchObject({
        command: 'aio-mcp',
        args: ['connector', 'remote-example'],
      });
      expect(() => connectorAccessRegistry.assert(provider, saved.record.id)).not.toThrow();
    }
    expect(() => connectorAccessRegistry.assert('unrelated', saved.record.id)).toThrow('not given');
  });
});
