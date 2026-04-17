import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateConfigIfNeeded } from '../config-migration';

describe('migrateConfigIfNeeded', () => {
  let tmpHome: string;
  let tmpTarget: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'));
    tmpTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-'));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpTarget, { recursive: true, force: true });
  });

  it('copies config from user home to target when target missing', async () => {
    const src = path.join(tmpHome, '.orchestrator', 'worker-node.json');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, JSON.stringify({ coordinatorUrl: 'ws://x' }));
    const dst = path.join(tmpTarget, 'worker-node.json');
    const result = await migrateConfigIfNeeded({ userConfigPath: src, serviceConfigPath: dst });
    expect(result.migrated).toBe(true);
    const copied = JSON.parse(await fs.readFile(dst, 'utf8'));
    expect(copied.coordinatorUrl).toBe('ws://x');
  });

  it('does nothing if target already exists', async () => {
    const src = path.join(tmpHome, 'a.json');
    const dst = path.join(tmpTarget, 'a.json');
    await fs.writeFile(src, '{}');
    await fs.writeFile(dst, '{"existing":true}');
    const result = await migrateConfigIfNeeded({ userConfigPath: src, serviceConfigPath: dst });
    expect(result.migrated).toBe(false);
    const content = JSON.parse(await fs.readFile(dst, 'utf8'));
    expect(content.existing).toBe(true);
  });
});
