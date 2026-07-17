import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  InstructionTrustStore,
  createInstructionTrustSchema,
  sha256OfContent,
} from './instruction-trust-store';

describe('InstructionTrustStore', () => {
  let db: SqliteDriver;
  let store: InstructionTrustStore;

  beforeEach(() => {
    InstructionTrustStore._resetForTesting();
    db = new Database(':memory:') as unknown as SqliteDriver;
    createInstructionTrustSchema(db);
    store = new InstructionTrustStore(db);
  });

  it('reports unknown for never-approved paths', () => {
    expect(store.evaluate('/p/CLAUDE.md', sha256OfContent('x'))).toBe('unknown');
  });

  it('approves a pin and matches by exact content hash', () => {
    const content = '# Project rules\nDo the thing.';
    store.approve('/p/CLAUDE.md', sha256OfContent(content));
    expect(store.evaluate('/p/CLAUDE.md', sha256OfContent(content))).toBe('approved');
  });

  it('reports changed when the content drifts from the pin', () => {
    store.approve('/p/CLAUDE.md', sha256OfContent('v1'));
    expect(store.evaluate('/p/CLAUDE.md', sha256OfContent('v2 — edited'))).toBe('changed');
  });

  it('re-approving updates the pin (upsert)', () => {
    store.approve('/p/CLAUDE.md', sha256OfContent('v1'));
    store.approve('/p/CLAUDE.md', sha256OfContent('v2'));
    expect(store.evaluate('/p/CLAUDE.md', sha256OfContent('v2'))).toBe('approved');
    expect(store.list()).toHaveLength(1);
  });

  it('revoke returns the path to unknown', () => {
    store.approve('/p/CLAUDE.md', sha256OfContent('v1'));
    store.revoke('/p/CLAUDE.md');
    expect(store.evaluate('/p/CLAUDE.md', sha256OfContent('v1'))).toBe('unknown');
  });

  it('lists pins ordered by path', () => {
    store.approve('/b/AGENTS.md', sha256OfContent('b'));
    store.approve('/a/CLAUDE.md', sha256OfContent('a'));
    expect(store.list().map((p) => p.canonicalPath)).toEqual(['/a/CLAUDE.md', '/b/AGENTS.md']);
  });
});
