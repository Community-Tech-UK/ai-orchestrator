import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { ClaudeMcpAdapter } from '../adapters/claude-mcp-adapter';
import { CodexMcpAdapter } from '../adapters/codex-mcp-adapter';
import { GeminiMcpAdapter } from '../adapters/gemini-mcp-adapter';
import { AntigravityMcpAdapter } from '../adapters/antigravity-mcp-adapter';
import { CopilotMcpAdapter } from '../adapters/copilot-mcp-adapter';
import { GrokMcpAdapter } from '../adapters/grok-mcp-adapter';
import { OpenCodeMcpAdapter } from '../adapters/opencode-mcp-adapter';
import { CliMcpConfigService } from '../cli-mcp-config-service';
import { OrchestratorMcpRepository } from '../orchestrator-mcp-repository';
import { RedactionService } from '../redaction-service';
import { SecretClassifier } from '../secret-classifier';
import { McpSecretStorage } from '../secret-storage';
import { WriteSafetyHelper } from '../write-safety-helper';

describe('MCP multi-provider service', () => {
  let tmp: string;
  let db: SqliteDriver;
  let service: CliMcpConfigService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-mcp-service-'));
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    const secrets = new McpSecretStorage({ safeStorage: { isEncryptionAvailable: () => false } });
    const writeSafety = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true });
    const adapters = {
      claude: new ClaudeMcpAdapter({ home: tmp, writeSafety }),
      codex: new CodexMcpAdapter({ codexHome: path.join(tmp, '.codex'), writeSafety }),
      gemini: new GeminiMcpAdapter({ home: tmp, writeSafety }),
      antigravity: new AntigravityMcpAdapter({ home: tmp, writeSafety }),
      copilot: new CopilotMcpAdapter({ home: tmp, writeSafety }),
      grok: new GrokMcpAdapter({ home: tmp, writeSafety }),
      opencode: new OpenCodeMcpAdapter({ home: tmp, writeSafety }),
    };
    service = new CliMcpConfigService({
      adapters,
      orchestratorRepo: new OrchestratorMcpRepository(db, secrets),
      connectorAuth: { status: () => ({ state: 'not-required' }) },
      agentsMayWrite: async () => false,
      graphAccounts: async () => [],
      redaction: new RedactionService(new SecretClassifier()),
      cwdProvider: () => tmp,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns redacted multi-provider state', async () => {
    await service.providerUserUpsert({
      provider: 'claude',
      id: 'claude:user:secret',
      name: 'secret',
      transport: 'stdio',
      command: 'node',
      env: { API_KEY: 'secret', HOME: '/tmp' },
      autoConnect: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const state = await service.getMultiProviderState();
    const claude = state.providers.find((provider) => provider.provider === 'claude');
    expect(claude?.servers[0]?.env).toEqual({ API_KEY: '***', HOME: '/tmp' });
  });

  it('preserves provider user env when an edit payload omits redacted values', async () => {
    await service.providerUserUpsert({
      provider: 'claude',
      id: 'claude:user:secret',
      name: 'secret',
      transport: 'stdio',
      command: 'node',
      env: { API_KEY: 'secret' },
      autoConnect: true,
      createdAt: 1,
      updatedAt: 1,
    });

    await service.providerUserUpsert({
      provider: 'claude',
      id: 'claude:user:secret',
      name: 'secret',
      transport: 'stdio',
      command: 'node',
      env: { HOME: '/tmp' },
      autoConnect: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const state = await service.getMultiProviderState();
    const claude = state.providers.find((provider) => provider.provider === 'claude');
    expect(claude?.servers[0]?.env).toEqual({ API_KEY: '***', HOME: '/tmp' });
  });

  it('keeps connectors available when one provider config cannot be parsed', async () => {
    const saved = service.orchestratorUpsert({ name: 'fs', transport: 'stdio', command: 'npx' });
    fs.writeFileSync(path.join(tmp, '.claude.json'), '{not-json');
    const state = await service.getMultiProviderState();
    expect(state.orchestrator.find((entry) => entry.record.id === saved.record.id)?.record.name).toBe('fs');
    expect(state).not.toHaveProperty('shared');
  });
});
