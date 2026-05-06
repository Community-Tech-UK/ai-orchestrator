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
import { CopilotMcpAdapter } from '../adapters/copilot-mcp-adapter';
import { CliMcpConfigService } from '../cli-mcp-config-service';
import { OrchestratorMcpRepository } from '../orchestrator-mcp-repository';
import { RedactionService } from '../redaction-service';
import { SecretClassifier } from '../secret-classifier';
import { McpSecretStorage } from '../secret-storage';
import { SharedMcpCoordinator } from '../shared-mcp-coordinator';
import { SharedMcpRepository } from '../shared-mcp-repository';
import { WriteSafetyHelper } from '../write-safety-helper';

describe('MCP multi-provider service', () => {
  let tmp: string;
  let db: SqliteDriver;
  let service: CliMcpConfigService;
  let shared: SharedMcpRepository;
  let coordinator: SharedMcpCoordinator;

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
      copilot: new CopilotMcpAdapter({ home: tmp, writeSafety }),
    };
    shared = new SharedMcpRepository(db, secrets);
    coordinator = new SharedMcpCoordinator({
      repo: shared,
      adapters,
      cwdProvider: () => tmp,
    });
    service = new CliMcpConfigService({
      adapters,
      orchestratorRepo: new OrchestratorMcpRepository(db, secrets),
      sharedRepo: shared,
      sharedCoordinator: coordinator,
      redaction: new RedactionService(new SecretClassifier()),
      cwdProvider: () => tmp,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fans out shared records and detects drift', async () => {
    const record = shared.upsert({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y'],
      targets: ['claude', 'codex'],
    });
    expect(await coordinator.fanOut(record.id)).toMatchObject([
      { provider: 'claude', state: 'in-sync' },
      { provider: 'codex', state: 'in-sync' },
    ]);

    const claudeConfig = path.join(tmp, '.claude.json');
    fs.writeFileSync(claudeConfig, fs.readFileSync(claudeConfig, 'utf8').replace('npx', 'DIFFERENT'));
    expect((await coordinator.getDrift(record.id)).find((status) => status.provider === 'claude')?.state)
      .toBe('drifted');
    await coordinator.resolveDrift(record.id, 'claude', 'overwrite-target');
    expect((await coordinator.getDrift(record.id)).find((status) => status.provider === 'claude')?.state)
      .toBe('in-sync');
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

  it('keeps shared state available when one provider config cannot be parsed', async () => {
    const record = shared.upsert({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      targets: ['claude'],
    });
    fs.writeFileSync(path.join(tmp, '.claude.json'), '{not-json');

    const state = await service.getMultiProviderState();
    const sharedRecord = state.shared.find((entry) => entry.record.id === record.id);
    expect(sharedRecord?.targets.find((target) => target.provider === 'claude')?.state)
      .toBe('missing');
  });
});
