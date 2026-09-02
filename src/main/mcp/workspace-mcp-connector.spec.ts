import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { McpSecretStorage } from './secret-storage';
import { WorkspaceMcpConnectorRepository } from './workspace-mcp-connector-repository';
import { WorkspaceMcpConnectorService } from './workspace-mcp-connector-service';
import { materializeWorkspaceMcpConnectors } from './workspace-mcp-connector-materialize';
import { toSecretWorkspaceId } from '../secrets/secret-workspace-key';
import { REDACTED_SENTINEL } from '../../shared/types/mcp-dtos.types';

const dbs: SqliteDriver[] = [];
const TOKEN = 'ghp_exampleplaceholdervalue0000000000';

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function storage(): McpSecretStorage {
  return new McpSecretStorage({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`),
      decryptString: (payload) => payload.toString('utf8').replace(/^enc:/, ''),
    },
  });
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
  vi.restoreAllMocks();
});

describe('workspace MCP connectors', () => {
  it('stores secret:// env refs in public JSON and encrypts ordinary secrets', () => {
    const db = openDb();
    const repo = new WorkspaceMcpConnectorRepository(db, storage());
    const saved = repo.upsert({
      workspaceId: toSecretWorkspaceId('/tmp/project-a'),
      provider: 'claude',
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
      env: { HOME: '/tmp', API_TOKEN: 'secret://linear-token', API_KEY: 'hunter2' },
    });

    expect(saved.env).toEqual({
      HOME: '/tmp',
      API_TOKEN: 'secret://linear-token',
      API_KEY: 'hunter2',
    });
    const row = db.prepare(`
      SELECT env_json, env_secrets_encrypted_json
      FROM workspace_mcp_connectors WHERE id = ?
    `).get<{ env_json: string; env_secrets_encrypted_json: string }>(saved.id);
    expect(row?.env_json).toContain('secret://linear-token');
    expect(row?.env_json).not.toContain('hunter2');
    expect(row?.env_secrets_encrypted_json).not.toContain('hunter2');
  });

  it('lists secret:// refs and redacts ordinary secrets', () => {
    const db = openDb();
    const service = new WorkspaceMcpConnectorService(
      new WorkspaceMcpConnectorRepository(db, storage()),
    );
    service.upsert({
      workingDirectory: '/tmp/project-a',
      provider: 'claude',
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
      env: { API_TOKEN: 'secret://linear-token', API_KEY: 'hunter2' },
    });

    const listed = service.list('/tmp/project-a', 'claude');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.env).toEqual({
      API_TOKEN: 'secret://linear-token',
      API_KEY: REDACTED_SENTINEL,
    });
  });

  it('refuses an unscoped working directory instead of falling back globally', () => {
    const service = new WorkspaceMcpConnectorService(
      new WorkspaceMcpConnectorRepository(openDb(), storage()),
    );
    expect(() => service.upsert({
      workingDirectory: '   ',
      provider: 'claude',
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
    })).toThrow(/will not fall back to a global MCP scope/);
  });

  it('refuses secret:// outside env', () => {
    const service = new WorkspaceMcpConnectorService(
      new WorkspaceMcpConnectorRepository(openDb(), storage()),
    );
    expect(() => service.upsert({
      workingDirectory: '/tmp/project-a',
      provider: 'claude',
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
      headers: { Authorization: 'secret://linear-token' },
    })).toThrow(/only allowed in connector env values/);
  });

  it('materialises matching local workspace/provider env and skips others', () => {
    const db = openDb();
    const repo = new WorkspaceMcpConnectorRepository(db, storage());

    repo.upsert({
      workspaceId: toSecretWorkspaceId('/tmp/project-a'),
      provider: 'claude',
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
      env: { API_TOKEN: 'secret://linear-token' },
    });
    repo.upsert({
      workspaceId: toSecretWorkspaceId('/tmp/project-b'),
      provider: 'claude',
      name: 'other',
      transport: 'stdio',
      command: 'npx',
      env: { API_TOKEN: 'secret://linear-token' },
    });
    repo.upsert({
      workspaceId: toSecretWorkspaceId('/tmp/project-a'),
      provider: 'codex',
      name: 'codex-only',
      transport: 'stdio',
      command: 'npx',
    });

    const configs = materializeWorkspaceMcpConnectors({
      executionLocation: { type: 'local' },
      workingDirectory: '/tmp/project-a',
      provider: 'claude',
      instanceId: 'inst-1',
      enabled: true,
      repository: repo,
      resolveSecret: (ref, opts) => {
        expect(ref).toBe('secret://linear-token');
        expect(opts.workspaceId).toBe(toSecretWorkspaceId('/tmp/project-a'));
        expect(opts.instanceId).toBe('inst-1');
        return TOKEN;
      },
    });
    expect(configs).toHaveLength(1);
    const parsed = JSON.parse(configs[0] ?? '{}') as {
      mcpServers: { linear: { env: { API_TOKEN: string } } };
    };
    expect(parsed.mcpServers.linear.env.API_TOKEN).toBe(TOKEN);
  });

  it('does not materialise remote or disabled connectors', () => {
    const repo = new WorkspaceMcpConnectorRepository(openDb(), storage());
    repo.upsert({
      workspaceId: toSecretWorkspaceId('/tmp/project-a'),
      provider: 'claude',
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
    });
    expect(materializeWorkspaceMcpConnectors({
      executionLocation: { type: 'remote', nodeId: 'node-1' },
      workingDirectory: '/tmp/project-a',
      provider: 'claude',
      enabled: true,
      repository: repo,
    })).toEqual([]);
    expect(materializeWorkspaceMcpConnectors({
      executionLocation: { type: 'local' },
      workingDirectory: '/tmp/project-a',
      provider: 'claude',
      enabled: false,
      repository: repo,
    })).toEqual([]);
  });

  it('fails closed when the referenced secret is missing', () => {
    const repo = new WorkspaceMcpConnectorRepository(openDb(), storage());
    repo.upsert({
      workspaceId: toSecretWorkspaceId('/tmp/project-a'),
      provider: 'claude',
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
      env: { API_TOKEN: 'secret://missing-token' },
    });
    expect(() => materializeWorkspaceMcpConnectors({
      executionLocation: { type: 'local' },
      workingDirectory: '/tmp/project-a',
      provider: 'claude',
      instanceId: 'inst-1',
      enabled: true,
      repository: repo,
      resolveSecret: () => {
        throw new Error('secret missing');
      },
    })).toThrow(/could not resolve env API_TOKEN/);
  });
});
