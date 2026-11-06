import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteWasmDatabase } from '../../../db/sqlite-wasm-driver';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import { RtkTrackingReader } from '../rtk-tracking-reader';

describe('RTK raw-command accounting against real SQL', () => {
  it('counts both proxy and bypass with exact command boundaries and preserves filters', () => {
    const root = mkdtempSync(join(tmpdir(), 'aio-rtk-bypass-'));
    const file = join(root, 'history.db');
    writeFileSync(file, '');
    const db = createSqliteWasmDatabase(':memory:') as unknown as SqliteDriver;
    db.exec('CREATE TABLE commands (timestamp TEXT, rtk_cmd TEXT, project_path TEXT)');
    const insert = db.prepare('INSERT INTO commands VALUES (?, ?, ?)');
    for (const command of ['rtk git status', 'rtk proxy npm test', 'rtk bypass cat file', 'rtk proxy', 'rtk bypass', 'rtk proxying']) {
      insert.run('2026-10-20T12:00:00.000Z', command, '/workspace');
    }
    insert.run('2026-10-20T12:00:00.000Z', 'rtk bypass cat file', '/other');
    insert.run('2026-10-01T12:00:00.000Z', 'rtk bypass cat file', '/workspace');
    const reader = new RtkTrackingReader({ dbPathOverride: file, driverFactory: () => db });
    try {
      expect(reader.getCompliance({ projectPath: '/workspace', sinceMs: Date.parse('2026-10-20') }))
        .toMatchObject({ filtered: 2, proxied: 4, proxyRatePct: 4 / 6 * 100 });
    } finally {
      reader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
