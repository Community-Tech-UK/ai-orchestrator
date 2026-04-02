import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationManager, type Migration } from './migration-manager';

describe('MigrationManager', () => {
  const migrations: Migration[] = [
    { version: 1, name: 'add-default-provider', up: vi.fn(async (config: Record<string, unknown>) => ({ ...config, defaultProvider: 'claude-cli' })) },
    { version: 2, name: 'rename-model-field', up: vi.fn(async (config: Record<string, unknown>) => { const { model, ...rest } = config; return { ...rest, modelId: (model as string) || 'claude-sonnet' }; }) },
    { version: 3, name: 'add-token-budget', up: vi.fn(async (config: Record<string, unknown>) => ({ ...config, tokenBudget: 200000 })) },
  ];

  let manager: MigrationManager;
  beforeEach(() => { manager = new MigrationManager(migrations); });

  it('runs all migrations from version 0', async () => {
    const result = await manager.migrate({ model: 'claude-3' }, 0);
    expect(result.config).toEqual({ modelId: 'claude-3', defaultProvider: 'claude-cli', tokenBudget: 200000 });
    expect(result.migrationsRun).toBe(3);
  });

  it('runs only pending migrations', async () => {
    const result = await manager.migrate({ defaultProvider: 'claude-cli', model: 'claude-3' }, 1);
    expect(result.migrationsRun).toBe(2);
    expect(result.fromVersion).toBe(1);
  });

  it('returns unchanged config if already current', async () => {
    const config = { modelId: 'x', defaultProvider: 'x', tokenBudget: 200000 };
    const result = await manager.migrate(config, 3);
    expect(result.migrationsRun).toBe(0);
  });

  it('returns current version number', () => {
    expect(manager.getCurrentVersion()).toBe(3);
  });

  it('handles migration errors gracefully', async () => {
    const failingMigrations: Migration[] = [
      { version: 1, name: 'good', up: vi.fn(async (c: Record<string, unknown>) => ({ ...c, added: true })) },
      { version: 2, name: 'bad', up: vi.fn(async () => { throw new Error('migration failed'); }) },
    ];
    const mgr = new MigrationManager(failingMigrations);
    const result = await mgr.migrate({}, 0);
    expect(result.error).toBe('migration failed');
    expect(result.migrationsRun).toBe(1);
    expect(result.toVersion).toBe(1);
  });
});
