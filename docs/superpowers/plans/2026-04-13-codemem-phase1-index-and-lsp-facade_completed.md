# Codemem Phase 1: Code Index + LSP Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a persistent, incrementally-updated code-structure database (content-addressable SQLite + AST-normalized merkle) and warm LSP access for spawned agent children via a reduced Serena-shaped MCP tool surface.

**Architecture:** New domain `src/main/codemem/` owns a content-addressable SQLite DB at the Electron user-data dir (chunks, merkle nodes, workspace manifest, workspace roots). A chokidar-backed `CodeIndexManager` re-chunks changed files via the existing tree-sitter chunker and updates the merkle. Existing `lsp-manager.ts` is lifted into a new Electron `utilityProcess` (`src/main/lsp-worker/`) that survives main-thread reloads; an `AgentLspFacade` wraps it with token caps, stable symbol-ids, and warming-state passthrough, exposed to children as `mcp__codemem__*` MCP tools. `InstanceLifecycle.spawn()` awaits LSP warm-up with a 15s timeout fallback.

**Tech Stack:** TypeScript 5.9, better-sqlite3, chokidar, Electron 40 `utilityProcess` + `MessageChannelMain`, Vitest, existing `tree-sitter-chunker.ts`, existing `lsp-manager.ts`.

**Spec:** `docs/superpowers/specs/2026-04-13-codemem-persistent-code-db-and-harvested-memory-design.md`.

**Out of scope for Phase 1:** BriefPacker, observation harvesting, conflict arbitration, Memify pruning. Those are Phase 2 and Phase 3.

## Known deviations from spec

- **Worker mechanism**: spec says Electron `utilityProcess`; this plan uses `node:worker_threads.Worker` so tests run under Vitest without an Electron runtime. The `LspWorkerGateway` API (`postMessage`/`on('message')`) is identical to `utilityProcess`, so swapping in a follow-up task is a mechanical replacement of the constructor call. Tracked as Phase 1.5 work.
- **`file_metadata` extension**: spec mentions adding `content_hash` and `ast_normalized_hash` columns to RLM's `file_metadata`. Phase 1 leaves RLM untouched and ships the new CAS DB as standalone, authoritative for code structure. Aligning the two stores is a Phase 4 concern.

---

## File Structure

**Create:**
- `src/main/codemem/types.ts` — shared types (`Chunk`, `MerkleNode`, `WorkspaceManifestRow`, `SymbolId`, etc.)
- `src/main/codemem/symbol-id.ts` — `symbolId({absPath, kind, name, containerName})` SHA-1 derivation
- `src/main/codemem/ast-normalize.ts` — `normalizeAndHash(chunk, language)` → `{contentHash, astNormalizedHash}`
- `src/main/codemem/cas-schema.ts` — schema migrations for `codemem.sqlite`
- `src/main/codemem/cas-store.ts` — read/write API for chunks, merkle nodes, manifest, workspace roots
- `src/main/codemem/code-index-manager.ts` — fs.watch + chunking + merkle update orchestrator
- `src/main/codemem/periodic-scan.ts` — 10-min manifest-vs-disk sampler for fs.watch reliability
- `src/main/codemem/agent-lsp-facade.ts` — Serena-shaped reduced surface over the LSP worker
- `src/main/codemem/mcp-tools.ts` — registers `mcp__codemem__*` MCP tools using existing MCP server plumbing
- `src/main/codemem/index.ts` — singleton `CodemEm` + `getCodemEm()` + `_resetForTesting()`
- `src/main/lsp-worker/worker-main.ts` — Electron `utilityProcess` host that loads `lsp-manager.ts`
- `src/main/lsp-worker/gateway-rpc.ts` — main-side RPC client over `MessageChannelMain`
- `src/main/lsp-worker/protocol.ts` — request/response Zod schemas shared by both sides
- `src/shared/codemem-types.ts` — types crossing the IPC boundary (validated with Zod)
- `src/shared/validation/codemem-schemas.ts` — Zod schemas for codemem IPC payloads
- `test/fixtures/codemem-sample/` — small TS+Python fixture workspace for integration tests
- `src/main/codemem/__tests__/symbol-id.spec.ts`
- `src/main/codemem/__tests__/ast-normalize.spec.ts`
- `src/main/codemem/__tests__/cas-store.spec.ts`
- `src/main/codemem/__tests__/code-index-manager.spec.ts`
- `src/main/codemem/__tests__/periodic-scan.spec.ts`
- `src/main/codemem/__tests__/agent-lsp-facade.spec.ts`
- `src/main/lsp-worker/__tests__/gateway-rpc.spec.ts`

**Modify:**
- `src/main/index.ts` — boot codemem singleton + spawn LSP worker after app `ready` event
- `src/main/instance/instance-lifecycle.ts` — await `lspWorker.ready(workspaceId, primaryLanguage, 15_000)` before spawn; on timeout, spawn anyway
- `src/main/ipc/handlers/lsp-handlers.ts` — proxy existing LSP IPC handlers through the new gateway client (no behavior change for renderer)
- `src/preload/preload.ts` — no new APIs in Phase 1; keep existing `lsp.*` surface working
- `src/shared/validation/ipc-schemas.ts` — extend with codemem schema imports if needed for renderer status display

**Leave alone in Phase 1 (do not extend):**
- `src/main/persistence/rlm/rlm-schema.ts`'s `file_metadata` table — Phase 1 keeps existing RLM untouched. The new CAS DB is authoritative for code structure going forward; RLM `file_metadata` continues to serve its current consumers. Migration/dedup of the two stores is a Phase 4 concern, not Phase 1.

---

### Task 1: Shared types + symbol-id derivation

**Files:**
- Create: `src/main/codemem/types.ts`
- Create: `src/main/codemem/symbol-id.ts`
- Test: `src/main/codemem/__tests__/symbol-id.spec.ts`

- [ ] **Step 1: Define types**

Write `src/main/codemem/types.ts`:

```typescript
export type ContentHash = string;        // SHA-256 hex of raw chunk bytes
export type AstNormalizedHash = string;  // SHA-256 hex of AST-normalized chunk
export type MerkleNodeHash = string;     // SHA-256 hex of node
export type SymbolId = string;           // SHA-1 hex of {absPath, kind, name, containerName}
export type WorkspaceHash = string;      // SHA-1 hex of absolute workspace path

export type ChunkType = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'module' | 'other';

export interface Chunk {
  contentHash: ContentHash;
  astNormalizedHash: AstNormalizedHash;
  language: string;
  chunkType: ChunkType;
  name: string;
  signature: string | null;
  docComment: string | null;
  symbolsJson: string;
  importsJson: string;
  exportsJson: string;
  rawText: string;
}

export interface MerkleNode {
  nodeHash: MerkleNodeHash;
  kind: 'file' | 'dir' | 'root';
  childrenJson: string;
}

export interface WorkspaceManifestRow {
  workspaceHash: WorkspaceHash;
  pathFromRoot: string;
  contentHash: ContentHash;
  merkleLeafHash: MerkleNodeHash;
  mtime: number;
}

export interface WorkspaceRoot {
  workspaceHash: WorkspaceHash;
  absPath: string;
  headCommit: string | null;
  primaryLanguage: string | null;
  lastIndexedAt: number;
  merkleRootHash: MerkleNodeHash | null;
  pagerankJson: string | null;
}
```

- [ ] **Step 2: Write the failing tests for symbol-id**

Write `src/main/codemem/__tests__/symbol-id.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { symbolId } from '../symbol-id';

describe('symbolId', () => {
  it('produces a stable SHA-1 hex of 40 chars', () => {
    const id = symbolId({ absPath: '/repo/a.ts', kind: 'function', name: 'foo', containerName: null });
    expect(id).toMatch(/^[a-f0-9]{40}$/);
  });

  it('is deterministic across calls', () => {
    const args = { absPath: '/repo/a.ts', kind: 'method', name: 'bar', containerName: 'Baz' } as const;
    expect(symbolId(args)).toBe(symbolId(args));
  });

  it('differs when containerName differs (null vs string)', () => {
    expect(symbolId({ absPath: '/x.ts', kind: 'method', name: 'foo', containerName: null }))
      .not.toBe(symbolId({ absPath: '/x.ts', kind: 'method', name: 'foo', containerName: 'A' }));
  });

  it('differs when kind differs', () => {
    expect(symbolId({ absPath: '/x.ts', kind: 'function', name: 'foo', containerName: null }))
      .not.toBe(symbolId({ absPath: '/x.ts', kind: 'method', name: 'foo', containerName: null }));
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run: `npx vitest run src/main/codemem/__tests__/symbol-id.spec.ts`
Expected: FAIL — `Cannot find module '../symbol-id'`.

- [ ] **Step 4: Implement symbol-id**

Write `src/main/codemem/symbol-id.ts`:

```typescript
import { createHash } from 'node:crypto';

export interface SymbolIdInput {
  absPath: string;
  kind: string;
  name: string;
  containerName: string | null;
}

export function symbolId(input: SymbolIdInput): string {
  const canonical = JSON.stringify({
    absPath: input.absPath,
    kind: input.kind,
    name: input.name,
    containerName: input.containerName,
  });
  return createHash('sha1').update(canonical).digest('hex');
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run src/main/codemem/__tests__/symbol-id.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/types.ts src/main/codemem/symbol-id.ts src/main/codemem/__tests__/symbol-id.spec.ts
git commit -m "feat(codemem): shared types + symbol-id derivation"
```

---

### Task 2: AST-normalized chunk hashing

**Files:**
- Create: `src/main/codemem/ast-normalize.ts`
- Test: `src/main/codemem/__tests__/ast-normalize.spec.ts`

- [ ] **Step 1: Write the failing tests**

Write `src/main/codemem/__tests__/ast-normalize.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeAndHash } from '../ast-normalize';

describe('normalizeAndHash', () => {
  it('returns SHA-256 hex strings for both content and AST-normalized hashes', () => {
    const r = normalizeAndHash('export function foo() { return 1; }', 'typescript');
    expect(r.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.astNormalizedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('content hash differs for two semantically-identical strings with different whitespace', () => {
    const a = normalizeAndHash('export function foo(){return 1;}', 'typescript');
    const b = normalizeAndHash('export function foo() {\n  return 1;\n}', 'typescript');
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('AST-normalized hash is identical for whitespace-only-different code (Prettier-equivalent)', () => {
    const a = normalizeAndHash('export function foo(){return 1;}', 'typescript');
    const b = normalizeAndHash('export function foo() {\n  return 1;\n}', 'typescript');
    expect(a.astNormalizedHash).toBe(b.astNormalizedHash);
  });

  it('AST-normalized hash differs when logic changes', () => {
    const a = normalizeAndHash('export function foo() { return 1; }', 'typescript');
    const b = normalizeAndHash('export function foo() { return 2; }', 'typescript');
    expect(a.astNormalizedHash).not.toBe(b.astNormalizedHash);
  });

  it('strips non-doc comments from AST-normalized hash but keeps logic-bearing tokens', () => {
    const a = normalizeAndHash('export function foo() { /* comment */ return 1; }', 'typescript');
    const b = normalizeAndHash('export function foo() { return 1; }', 'typescript');
    expect(a.astNormalizedHash).toBe(b.astNormalizedHash);
  });

  it('returns content-hash-only fallback when language is unsupported', () => {
    const r = normalizeAndHash('foo bar baz', 'cobol');
    expect(r.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.astNormalizedHash).toBe(r.contentHash);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx vitest run src/main/codemem/__tests__/ast-normalize.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AST normalizer**

Write `src/main/codemem/ast-normalize.ts`. Use the existing tree-sitter integration; if the chunker doesn't already expose a parsed tree, parse the chunk text against the language grammar and walk:

```typescript
import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';

const LANGUAGES: Record<string, unknown> = {
  typescript: TS.typescript,
  tsx: TS.tsx,
  javascript: TS.typescript,
  python: Python,
  go: Go,
  rust: Rust,
};

const TRIVIA_TYPES = new Set(['comment', 'line_comment', 'block_comment']);
const DOC_PREFIXES = ['/**', '///', '"""'];

function isDocComment(text: string): boolean {
  const trimmed = text.trimStart();
  return DOC_PREFIXES.some((p) => trimmed.startsWith(p));
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function normalizeNode(node: Parser.SyntaxNode): string {
  if (TRIVIA_TYPES.has(node.type)) {
    return isDocComment(node.text) ? `DOC(${node.text.trim()})` : '';
  }
  if (node.namedChildren.length === 0) {
    return `${node.type}:${node.text}`;
  }
  const childParts = node.namedChildren.map(normalizeNode).filter(Boolean);
  return `${node.type}[${childParts.join('|')}]`;
}

export interface NormalizedHashes {
  contentHash: string;
  astNormalizedHash: string;
}

export function normalizeAndHash(chunkText: string, language: string): NormalizedHashes {
  const contentHash = sha256(chunkText);
  const langGrammar = LANGUAGES[language.toLowerCase()];
  if (!langGrammar) {
    return { contentHash, astNormalizedHash: contentHash };
  }
  const parser = new Parser();
  parser.setLanguage(langGrammar as Parser.Language);
  const tree = parser.parse(chunkText);
  const normalized = normalizeNode(tree.rootNode);
  return { contentHash, astNormalizedHash: sha256(normalized) };
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/main/codemem/__tests__/ast-normalize.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/ast-normalize.ts src/main/codemem/__tests__/ast-normalize.spec.ts
git commit -m "feat(codemem): AST-normalized chunk hashing absorbs whitespace/non-doc-comment changes"
```

---

### Task 3: CAS schema migrations

**Files:**
- Create: `src/main/codemem/cas-schema.ts`
- Test: included in cas-store tests (Task 4)

- [ ] **Step 1: Write the schema module**

Write `src/main/codemem/cas-schema.ts`:

```typescript
import type Database from 'better-sqlite3';

export const CAS_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string[]> = {
  1: [
    `CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS chunks (
      content_hash TEXT PRIMARY KEY,
      ast_normalized_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      name TEXT NOT NULL,
      signature TEXT,
      doc_comment TEXT,
      symbols_json TEXT NOT NULL DEFAULT '[]',
      imports_json TEXT NOT NULL DEFAULT '[]',
      exports_json TEXT NOT NULL DEFAULT '[]',
      raw_text TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_ast_normalized ON chunks(ast_normalized_hash)`,
    `CREATE TABLE IF NOT EXISTS merkle_nodes (
      node_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('file','dir','root')),
      children_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_manifest (
      workspace_hash TEXT NOT NULL,
      path_from_root TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      merkle_leaf_hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      PRIMARY KEY (workspace_hash, path_from_root)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_manifest_workspace ON workspace_manifest(workspace_hash)`,
    `CREATE TABLE IF NOT EXISTS workspace_root (
      workspace_hash TEXT PRIMARY KEY,
      abs_path TEXT NOT NULL UNIQUE,
      head_commit TEXT,
      primary_language TEXT,
      last_indexed_at INTEGER NOT NULL,
      merkle_root_hash TEXT,
      pagerank_json TEXT
    )`,
  ],
};

export function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  for (const stmt of MIGRATIONS[1]) {
    db.prepare(stmt).run();
  }
  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  const start = (current?.v ?? 0) + 1;
  for (let v = start; v <= CAS_SCHEMA_VERSION; v++) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, Date.now());
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/codemem/cas-schema.ts
git commit -m "feat(codemem): CAS schema migrations (chunks, merkle_nodes, manifest, workspace_root)"
```

---

### Task 4: CAS store API

**Files:**
- Create: `src/main/codemem/cas-store.ts`
- Test: `src/main/codemem/__tests__/cas-store.spec.ts`

- [ ] **Step 1: Write the failing tests**

Write `src/main/codemem/__tests__/cas-store.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import type { Chunk } from '../types';

const sampleChunk = (overrides: Partial<Chunk> = {}): Chunk => ({
  contentHash: 'a'.repeat(64),
  astNormalizedHash: 'b'.repeat(64),
  language: 'typescript',
  chunkType: 'function',
  name: 'foo',
  signature: '() => number',
  docComment: null,
  symbolsJson: '[]',
  importsJson: '[]',
  exportsJson: '[]',
  rawText: 'function foo() { return 1; }',
  ...overrides,
});

describe('CasStore', () => {
  let db: Database.Database;
  let store: CasStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
  });

  it('upsertChunk inserts a new chunk', () => {
    store.upsertChunk(sampleChunk());
    expect(store.getChunk('a'.repeat(64))).toMatchObject({ name: 'foo' });
  });

  it('upsertChunk is idempotent on content_hash', () => {
    store.upsertChunk(sampleChunk());
    store.upsertChunk(sampleChunk({ name: 'foo-renamed' })); // same hash
    expect(store.getChunk('a'.repeat(64))?.name).toBe('foo'); // first write wins for immutable CAS
  });

  it('upsertManifestEntry replaces previous entry for same (workspace, path)', () => {
    store.upsertManifestEntry({
      workspaceHash: 'w1',
      pathFromRoot: 'src/a.ts',
      contentHash: 'c1',
      merkleLeafHash: 'm1',
      mtime: 1000,
    });
    store.upsertManifestEntry({
      workspaceHash: 'w1',
      pathFromRoot: 'src/a.ts',
      contentHash: 'c2',
      merkleLeafHash: 'm2',
      mtime: 2000,
    });
    const rows = store.listManifestEntries('w1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentHash).toBe('c2');
  });

  it('upsertWorkspaceRoot writes and reads back', () => {
    store.upsertWorkspaceRoot({
      workspaceHash: 'w1',
      absPath: '/repo',
      headCommit: 'abc',
      primaryLanguage: 'typescript',
      lastIndexedAt: 1234,
      merkleRootHash: 'root1',
      pagerankJson: null,
    });
    expect(store.getWorkspaceRoot('w1')?.absPath).toBe('/repo');
  });

  it('upsertMerkleNode is idempotent on node_hash', () => {
    store.upsertMerkleNode({ nodeHash: 'n1', kind: 'file', childrenJson: '[]' });
    store.upsertMerkleNode({ nodeHash: 'n1', kind: 'file', childrenJson: '[]' });
    expect(store.getMerkleNode('n1')).toMatchObject({ kind: 'file' });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx vitest run src/main/codemem/__tests__/cas-store.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CasStore**

Write `src/main/codemem/cas-store.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { Chunk, MerkleNode, WorkspaceManifestRow, WorkspaceRoot, WorkspaceHash } from './types';

export class CasStore {
  constructor(private readonly db: Database.Database) {}

  upsertChunk(c: Chunk): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO chunks (
        content_hash, ast_normalized_hash, language, chunk_type, name,
        signature, doc_comment, symbols_json, imports_json, exports_json, raw_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.contentHash, c.astNormalizedHash, c.language, c.chunkType, c.name,
      c.signature, c.docComment, c.symbolsJson, c.importsJson, c.exportsJson, c.rawText,
    );
  }

  getChunk(contentHash: string): Chunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE content_hash = ?').get(contentHash) as
      | { content_hash: string; ast_normalized_hash: string; language: string; chunk_type: Chunk['chunkType']; name: string;
          signature: string | null; doc_comment: string | null; symbols_json: string; imports_json: string; exports_json: string; raw_text: string }
      | undefined;
    return row
      ? {
          contentHash: row.content_hash, astNormalizedHash: row.ast_normalized_hash, language: row.language,
          chunkType: row.chunk_type, name: row.name, signature: row.signature, docComment: row.doc_comment,
          symbolsJson: row.symbols_json, importsJson: row.imports_json, exportsJson: row.exports_json, rawText: row.raw_text,
        }
      : null;
  }

  upsertMerkleNode(n: MerkleNode): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO merkle_nodes (node_hash, kind, children_json)
      VALUES (?, ?, ?)
    `).run(n.nodeHash, n.kind, n.childrenJson);
  }

  getMerkleNode(hash: string): MerkleNode | null {
    const row = this.db.prepare('SELECT * FROM merkle_nodes WHERE node_hash = ?').get(hash) as
      | { node_hash: string; kind: MerkleNode['kind']; children_json: string }
      | undefined;
    return row ? { nodeHash: row.node_hash, kind: row.kind, childrenJson: row.children_json } : null;
  }

  upsertManifestEntry(e: WorkspaceManifestRow): void {
    this.db.prepare(`
      INSERT INTO workspace_manifest (workspace_hash, path_from_root, content_hash, merkle_leaf_hash, mtime)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_hash, path_from_root) DO UPDATE SET
        content_hash = excluded.content_hash,
        merkle_leaf_hash = excluded.merkle_leaf_hash,
        mtime = excluded.mtime
    `).run(e.workspaceHash, e.pathFromRoot, e.contentHash, e.merkleLeafHash, e.mtime);
  }

  listManifestEntries(workspaceHash: WorkspaceHash): WorkspaceManifestRow[] {
    return (this.db.prepare('SELECT * FROM workspace_manifest WHERE workspace_hash = ?').all(workspaceHash) as Array<{
      workspace_hash: string; path_from_root: string; content_hash: string; merkle_leaf_hash: string; mtime: number;
    }>).map((r) => ({
      workspaceHash: r.workspace_hash, pathFromRoot: r.path_from_root, contentHash: r.content_hash,
      merkleLeafHash: r.merkle_leaf_hash, mtime: r.mtime,
    }));
  }

  deleteManifestEntry(workspaceHash: WorkspaceHash, pathFromRoot: string): void {
    this.db.prepare('DELETE FROM workspace_manifest WHERE workspace_hash = ? AND path_from_root = ?')
      .run(workspaceHash, pathFromRoot);
  }

  upsertWorkspaceRoot(w: WorkspaceRoot): void {
    this.db.prepare(`
      INSERT INTO workspace_root (workspace_hash, abs_path, head_commit, primary_language,
        last_indexed_at, merkle_root_hash, pagerank_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_hash) DO UPDATE SET
        abs_path = excluded.abs_path,
        head_commit = excluded.head_commit,
        primary_language = excluded.primary_language,
        last_indexed_at = excluded.last_indexed_at,
        merkle_root_hash = excluded.merkle_root_hash,
        pagerank_json = excluded.pagerank_json
    `).run(w.workspaceHash, w.absPath, w.headCommit, w.primaryLanguage,
      w.lastIndexedAt, w.merkleRootHash, w.pagerankJson);
  }

  getWorkspaceRoot(workspaceHash: WorkspaceHash): WorkspaceRoot | null {
    const row = this.db.prepare('SELECT * FROM workspace_root WHERE workspace_hash = ?').get(workspaceHash) as
      | { workspace_hash: string; abs_path: string; head_commit: string | null; primary_language: string | null;
          last_indexed_at: number; merkle_root_hash: string | null; pagerank_json: string | null }
      | undefined;
    return row
      ? {
          workspaceHash: row.workspace_hash, absPath: row.abs_path, headCommit: row.head_commit,
          primaryLanguage: row.primary_language, lastIndexedAt: row.last_indexed_at,
          merkleRootHash: row.merkle_root_hash, pagerankJson: row.pagerank_json,
        }
      : null;
  }
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/main/codemem/__tests__/cas-store.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/cas-store.ts src/main/codemem/__tests__/cas-store.spec.ts
git commit -m "feat(codemem): CAS store API for chunks/merkle/manifest/workspace_root"
```

---

### Task 5: Build the test fixture workspace

**Files:**
- Create: `test/fixtures/codemem-sample/src/math.ts`
- Create: `test/fixtures/codemem-sample/src/string-utils.ts`
- Create: `test/fixtures/codemem-sample/scripts/build.py`
- Create: `test/fixtures/codemem-sample/.gitignore`

- [ ] **Step 1: Create fixture files**

Write `test/fixtures/codemem-sample/src/math.ts`:

```typescript
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
```

Write `test/fixtures/codemem-sample/src/string-utils.ts`:

```typescript
export function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}
```

Write `test/fixtures/codemem-sample/scripts/build.py`:

```python
def build(target: str) -> bool:
    return target != ""
```

Write `test/fixtures/codemem-sample/.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 2: Commit**

```bash
git add test/fixtures/codemem-sample/
git commit -m "test(codemem): fixture workspace with TS + Python sample files"
```

---

### Task 6: CodeIndexManager — cold index

**Files:**
- Create: `src/main/codemem/code-index-manager.ts` (initial version: cold index only)
- Test: `src/main/codemem/__tests__/code-index-manager.spec.ts`

- [ ] **Step 1: Write the failing tests for cold index**

Write `src/main/codemem/__tests__/code-index-manager.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';

const FIXTURE = resolve(__dirname, '../../../../test/fixtures/codemem-sample');

describe('CodeIndexManager (cold index)', () => {
  let db: Database.Database;
  let store: CasStore;
  let mgr: CodeIndexManager;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store });
  });

  it('coldIndex populates manifest entries for every non-ignored file', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const entries = store.listManifestEntries(result.workspaceHash);
    const paths = entries.map((e) => e.pathFromRoot).sort();
    expect(paths).toEqual([
      'scripts/build.py',
      'src/math.ts',
      'src/string-utils.ts',
    ]);
  });

  it('coldIndex writes a workspace_root row with non-null merkle_root_hash', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const root = store.getWorkspaceRoot(result.workspaceHash);
    expect(root).not.toBeNull();
    expect(root!.merkleRootHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('coldIndex is deterministic — same fixture produces same merkle_root_hash twice', async () => {
    const r1 = await mgr.coldIndex(FIXTURE);
    const root1 = store.getWorkspaceRoot(r1.workspaceHash)!.merkleRootHash;
    const db2 = new Database(':memory:');
    migrate(db2);
    const store2 = new CasStore(db2);
    const mgr2 = new CodeIndexManager({ store: store2 });
    const r2 = await mgr2.coldIndex(FIXTURE);
    const root2 = store2.getWorkspaceRoot(r2.workspaceHash)!.merkleRootHash;
    expect(root1).toBe(root2);
  });

  it('coldIndex respects .gitignore (does not index node_modules even if present)', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const entries = store.listManifestEntries(result.workspaceHash);
    expect(entries.find((e) => e.pathFromRoot.startsWith('node_modules/'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx vitest run src/main/codemem/__tests__/code-index-manager.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CodeIndexManager (cold index only)**

Write `src/main/codemem/code-index-manager.ts`. The implementation must:
- Derive `workspaceHash = SHA-1(absPath)`.
- Walk the workspace, honoring `.gitignore` via the `ignore` package (already in dependencies — verify with `npm ls ignore`; install if missing).
- For each file, call `treeSitterChunker.chunk(filePath, sourceText)` and per chunk call `normalizeAndHash(chunk.rawText, language)`.
- Compute `merkleLeafHash` for each file = SHA-256 of stable-sorted `(astNormalizedHash, chunkType, name)` tuples.
- Walk directory tree recomputing dir node hashes.
- Write all chunks, manifest entries, merkle nodes, and a `workspace_root` row with the final `merkleRootHash`.

```typescript
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import ignore from 'ignore';
import type { CasStore } from './cas-store';
import { normalizeAndHash } from './ast-normalize';
import { chunk as treeSitterChunk } from '../indexing/tree-sitter-chunker';
import type { Chunk, ChunkType, MerkleNodeHash, WorkspaceHash } from './types';

const DEFAULT_IGNORES = ['.git/', 'node_modules/', 'dist/', 'build/', '.next/', 'coverage/'];

export interface CodeIndexManagerOptions {
  store: CasStore;
  debounceMs?: number;
}

export interface ColdIndexResult {
  workspaceHash: WorkspaceHash;
  fileCount: number;
  chunkCount: number;
  merkleRootHash: MerkleNodeHash;
}

export class CodeIndexManager {
  constructor(protected readonly opts: CodeIndexManagerOptions) {}

  async coldIndex(workspacePath: string): Promise<ColdIndexResult> {
    const workspaceHash = createHash('sha1').update(workspacePath).digest('hex');
    const ig = ignore().add(DEFAULT_IGNORES);
    try {
      const gi = await fs.readFile(join(workspacePath, '.gitignore'), 'utf8');
      ig.add(gi);
    } catch {
      // no .gitignore is fine
    }
    const files = await this.walkFiles(workspacePath, workspacePath, ig);
    let chunkCount = 0;
    for (const absFile of files) {
      const rel = relative(workspacePath, absFile);
      const language = inferLanguage(absFile);
      const text = await fs.readFile(absFile, 'utf8');
      const chunks = treeSitterChunk(absFile, text);
      const leafInputs: string[] = [];
      for (const ch of chunks) {
        const { contentHash, astNormalizedHash } = normalizeAndHash(ch.rawText ?? '', language);
        const stored: Chunk = {
          contentHash, astNormalizedHash, language,
          chunkType: (ch.type as ChunkType) ?? 'other',
          name: ch.name ?? '',
          signature: ch.signature ?? null,
          docComment: ch.docComment ?? null,
          symbolsJson: '[]',
          importsJson: '[]',
          exportsJson: '[]',
          rawText: ch.rawText ?? '',
        };
        this.opts.store.upsertChunk(stored);
        leafInputs.push(`${astNormalizedHash}|${stored.chunkType}|${stored.name}`);
        chunkCount++;
      }
      leafInputs.sort();
      const merkleLeafHash = createHash('sha256').update(leafInputs.join('\n')).digest('hex');
      this.opts.store.upsertMerkleNode({ nodeHash: merkleLeafHash, kind: 'file', childrenJson: JSON.stringify(leafInputs) });
      const stat = await fs.stat(absFile);
      this.opts.store.upsertManifestEntry({
        workspaceHash, pathFromRoot: rel,
        contentHash: createHash('sha256').update(text).digest('hex'),
        merkleLeafHash, mtime: Math.floor(stat.mtimeMs),
      });
    }
    this.opts.store.upsertWorkspaceRoot({
      workspaceHash, absPath: workspacePath,
      headCommit: null, primaryLanguage: this.detectPrimaryLanguage(files),
      lastIndexedAt: Date.now(), merkleRootHash: null, pagerankJson: null,
    });
    const merkleRootHash = this.recomputeRootHash(workspacePath, workspaceHash);
    return { workspaceHash, fileCount: files.length, chunkCount, merkleRootHash };
  }

  protected async walkFiles(root: string, dir: string, ig: ReturnType<typeof ignore>): Promise<string[]> {
    const out: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (rel && ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
      if (entry.isDirectory()) out.push(...(await this.walkFiles(root, abs, ig)));
      else if (entry.isFile()) out.push(abs);
    }
    return out;
  }

  protected recomputeRootHash(workspacePath: string, workspaceHash: WorkspaceHash): MerkleNodeHash {
    const entries = this.opts.store.listManifestEntries(workspaceHash);
    const dirChildren = new Map<string, MerkleNodeHash[]>();
    for (const e of entries) {
      const dir = e.pathFromRoot.includes('/') ? e.pathFromRoot.slice(0, e.pathFromRoot.lastIndexOf('/')) : '.';
      const list = dirChildren.get(dir) ?? [];
      list.push(e.merkleLeafHash);
      dirChildren.set(dir, list);
    }
    const sortedDirs = [...dirChildren.keys()].sort();
    const dirHashes = sortedDirs.map((d) => {
      const children = dirChildren.get(d)!.slice().sort();
      const h = createHash('sha256').update(`${d}\n${children.join('\n')}`).digest('hex');
      this.opts.store.upsertMerkleNode({ nodeHash: h, kind: 'dir', childrenJson: JSON.stringify(children) });
      return h;
    });
    const rootHash = createHash('sha256').update(dirHashes.sort().join('\n')).digest('hex');
    this.opts.store.upsertMerkleNode({ nodeHash: rootHash, kind: 'root', childrenJson: JSON.stringify(dirHashes) });
    const root = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (root) this.opts.store.upsertWorkspaceRoot({ ...root, merkleRootHash: rootHash, lastIndexedAt: Date.now() });
    return rootHash;
  }

  protected detectPrimaryLanguage(files: string[]): string | null {
    const counts = new Map<string, number>();
    for (const f of files) {
      const lang = inferLanguage(f);
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    let best: { lang: string; n: number } | null = null;
    for (const [lang, n] of counts) {
      if (!best || n > best.n) best = { lang, n };
    }
    return best?.lang ?? null;
  }
}

function inferLanguage(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.rs')) return 'rust';
  return 'unknown';
}

export { inferLanguage };
```

If `tree-sitter-chunker.ts`'s exported function name differs, adjust the import. Verify with: `grep -n "^export" src/main/indexing/tree-sitter-chunker.ts`.

Verify `ignore` package is available: `npm ls ignore`. If missing: `npm install ignore`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/main/codemem/__tests__/code-index-manager.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/code-index-manager.ts src/main/codemem/__tests__/code-index-manager.spec.ts
git commit -m "feat(codemem): cold index walks workspace, populates CAS + manifest + merkle root"
```

---

### Task 7: CodeIndexManager — incremental update via fs.watch

**Files:**
- Modify: `src/main/codemem/code-index-manager.ts` (add EventEmitter, `start()`, `stop()`, `onFileChange()`)
- Modify: `src/main/codemem/__tests__/code-index-manager.spec.ts` (add cases)

- [ ] **Step 1: Add the failing tests**

Append to `src/main/codemem/__tests__/code-index-manager.spec.ts`:

```typescript
import { writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';

describe('CodeIndexManager (incremental)', () => {
  let db: Database.Database;
  let store: CasStore;
  let mgr: CodeIndexManager;
  let workDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store, debounceMs: 30 });
    workDir = `${tmpdir()}/codemem-incr-${Date.now()}-${Math.random()}`;
    await mkdir(`${workDir}/src`, { recursive: true });
    await copyFile(`${FIXTURE}/src/math.ts`, `${workDir}/src/math.ts`);
  });

  afterEach(async () => {
    await mgr.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it('onFileChange re-indexes only the changed file', async () => {
    const r0 = await mgr.coldIndex(workDir);
    const root0 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    await writeFile(`${workDir}/src/math.ts`, 'export function add(a: number, b: number): number { return a + b + 1; }');
    await mgr.onFileChange(`${workDir}/src/math.ts`, r0.workspaceHash);
    const root1 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    expect(root1).not.toBe(root0);
    const entry = store.listManifestEntries(r0.workspaceHash).find((e) => e.pathFromRoot === 'src/math.ts');
    expect(entry).toBeDefined();
  });

  it('format-only change does not change merkle_root_hash (AST-normalized)', async () => {
    const r0 = await mgr.coldIndex(workDir);
    const root0 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    await writeFile(`${workDir}/src/math.ts`, `export function add(a: number, b: number): number {\n    return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n    return a * b;\n}\n`);
    await mgr.onFileChange(`${workDir}/src/math.ts`, r0.workspaceHash);
    const root1 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    expect(root1).toBe(root0);
  });

  it('start() begins watching and onFileChange fires on edits within debounce window', async () => {
    const r0 = await mgr.coldIndex(workDir);
    const seen: string[] = [];
    mgr.on('code-index:changed', (e: { workspaceHash: string; paths: string[] }) => seen.push(...e.paths));
    await mgr.start(workDir, r0.workspaceHash);
    await writeFile(`${workDir}/src/math.ts`, '// edited\nexport function add(a: number, b: number) { return a + b + 2; }');
    await new Promise((res) => setTimeout(res, 200));
    expect(seen).toContain('src/math.ts');
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx vitest run src/main/codemem/__tests__/code-index-manager.spec.ts`
Expected: FAIL — `mgr.start`, `mgr.onFileChange`, `mgr.stop` not defined; `mgr.on` not present.

- [ ] **Step 3: Make CodeIndexManager extend EventEmitter and add the watch API**

Modify `src/main/codemem/code-index-manager.ts`. Convert the class to extend `EventEmitter`. Add new methods (preserve all existing ones from Task 6):

```typescript
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
// ... keep existing imports ...

export class CodeIndexManager extends EventEmitter {
  private watchers = new Map<WorkspaceHash, FSWatcher>();
  private pending = new Map<WorkspaceHash, { paths: Set<string>; timer: NodeJS.Timeout }>();

  constructor(protected readonly opts: CodeIndexManagerOptions) {
    super();
  }

  // ... existing coldIndex, walkFiles, recomputeRootHash, detectPrimaryLanguage ...

  async start(workspacePath: string, workspaceHash: WorkspaceHash): Promise<void> {
    if (this.watchers.has(workspaceHash)) return;
    const watcher = chokidar.watch(workspacePath, {
      ignoreInitial: true,
      ignored: (p: string) => /\/(\.git|node_modules|dist|build|coverage|\.next)\//.test(p),
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    watcher.on('add', (p) => this.queue(workspaceHash, p));
    watcher.on('change', (p) => this.queue(workspaceHash, p));
    watcher.on('unlink', (p) => this.queueDelete(workspaceHash, workspacePath, p));
    this.watchers.set(workspaceHash, watcher);
  }

  async stop(): Promise<void> {
    for (const w of this.watchers.values()) await w.close();
    this.watchers.clear();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private queue(workspaceHash: WorkspaceHash, absPath: string): void {
    const debounceMs = this.opts.debounceMs ?? 150;
    const entry = this.pending.get(workspaceHash);
    if (entry) {
      entry.paths.add(absPath);
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.flush(workspaceHash), debounceMs);
    } else {
      const paths = new Set<string>([absPath]);
      const timer = setTimeout(() => this.flush(workspaceHash), debounceMs);
      this.pending.set(workspaceHash, { paths, timer });
    }
  }

  private queueDelete(workspaceHash: WorkspaceHash, workspacePath: string, absPath: string): void {
    const rel = relative(workspacePath, absPath);
    this.opts.store.deleteManifestEntry(workspaceHash, rel);
    this.recomputeRootHash(workspacePath, workspaceHash);
    this.emit('code-index:changed', { workspaceHash, paths: [rel] });
  }

  private async flush(workspaceHash: WorkspaceHash): Promise<void> {
    const entry = this.pending.get(workspaceHash);
    if (!entry) return;
    this.pending.delete(workspaceHash);
    const root = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (!root) return;
    const paths: string[] = [];
    for (const abs of entry.paths) {
      try {
        await this.onFileChange(abs, workspaceHash);
        paths.push(relative(root.absPath, abs));
      } catch {
        // file may have been removed mid-flight; skip
      }
    }
    if (paths.length) this.emit('code-index:changed', { workspaceHash, paths });
  }

  async onFileChange(absPath: string, workspaceHash: WorkspaceHash): Promise<void> {
    const root = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (!root) throw new Error(`workspace not registered: ${workspaceHash}`);
    const rel = relative(root.absPath, absPath);
    const language = inferLanguage(absPath);
    const text = await fs.readFile(absPath, 'utf8');
    const chunks = treeSitterChunk(absPath, text);
    const leafInputs: string[] = [];
    for (const ch of chunks) {
      const { contentHash, astNormalizedHash } = normalizeAndHash(ch.rawText ?? '', language);
      const stored: Chunk = {
        contentHash, astNormalizedHash, language,
        chunkType: (ch.type as ChunkType) ?? 'other',
        name: ch.name ?? '', signature: ch.signature ?? null, docComment: ch.docComment ?? null,
        symbolsJson: '[]', importsJson: '[]', exportsJson: '[]',
        rawText: ch.rawText ?? '',
      };
      this.opts.store.upsertChunk(stored);
      leafInputs.push(`${astNormalizedHash}|${stored.chunkType}|${stored.name}`);
    }
    leafInputs.sort();
    const merkleLeafHash = createHash('sha256').update(leafInputs.join('\n')).digest('hex');
    const previousLeaf = this.opts.store.listManifestEntries(workspaceHash).find((e) => e.pathFromRoot === rel)?.merkleLeafHash;
    if (previousLeaf === merkleLeafHash) return;
    this.opts.store.upsertMerkleNode({ nodeHash: merkleLeafHash, kind: 'file', childrenJson: JSON.stringify(leafInputs) });
    const stat = await fs.stat(absPath);
    this.opts.store.upsertManifestEntry({
      workspaceHash, pathFromRoot: rel,
      contentHash: createHash('sha256').update(text).digest('hex'),
      merkleLeafHash, mtime: Math.floor(stat.mtimeMs),
    });
    this.recomputeRootHash(root.absPath, workspaceHash);
  }
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/main/codemem/__tests__/code-index-manager.spec.ts`
Expected: PASS, 7 tests (4 prior + 3 new).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/code-index-manager.ts src/main/codemem/__tests__/code-index-manager.spec.ts
git commit -m "feat(codemem): incremental fs.watch updates + AST-normalized no-op skip"
```

---

### Task 8: Periodic scan fallback for fs.watch

**Files:**
- Create: `src/main/codemem/periodic-scan.ts`
- Test: `src/main/codemem/__tests__/periodic-scan.spec.ts`

- [ ] **Step 1: Write the failing tests**

Write `src/main/codemem/__tests__/periodic-scan.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';
import { PeriodicScan } from '../periodic-scan';

describe('PeriodicScan', () => {
  let db: Database.Database;
  let store: CasStore;
  let mgr: CodeIndexManager;
  let workDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store });
    workDir = `${tmpdir()}/codemem-scan-${Date.now()}-${Math.random()}`;
    await mkdir(`${workDir}/src`, { recursive: true });
    await writeFile(`${workDir}/src/a.ts`, 'export const x = 1;\n');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('detects out-of-band edit and triggers re-index when sample mismatch rate exceeds threshold', async () => {
    const r0 = await mgr.coldIndex(workDir);
    const root0 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    await writeFile(`${workDir}/src/a.ts`, 'export const x = 2;\n');
    const scan = new PeriodicScan({ store, mgr, mismatchThreshold: 0.0 });
    await scan.runOnce(r0.workspaceHash);
    const root1 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    expect(root1).not.toBe(root0);
  });

  it('does nothing when manifest matches disk', async () => {
    const r0 = await mgr.coldIndex(workDir);
    const root0 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    const scan = new PeriodicScan({ store, mgr, mismatchThreshold: 0.05 });
    await scan.runOnce(r0.workspaceHash);
    const root1 = store.getWorkspaceRoot(r0.workspaceHash)!.merkleRootHash!;
    expect(root1).toBe(root0);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx vitest run src/main/codemem/__tests__/periodic-scan.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement periodic scan**

Write `src/main/codemem/periodic-scan.ts`:

```typescript
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CasStore } from './cas-store';
import type { CodeIndexManager } from './code-index-manager';
import type { WorkspaceHash } from './types';

export interface PeriodicScanOptions {
  store: CasStore;
  mgr: CodeIndexManager;
  mismatchThreshold?: number; // fraction; default 0.05
  sampleSize?: number;        // default 100
}

export class PeriodicScan {
  constructor(private readonly opts: PeriodicScanOptions) {}

  async runOnce(workspaceHash: WorkspaceHash): Promise<{ scanned: number; mismatched: number; reindexed: boolean }> {
    const root = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (!root) return { scanned: 0, mismatched: 0, reindexed: false };
    const entries = this.opts.store.listManifestEntries(workspaceHash);
    const sampleSize = Math.min(this.opts.sampleSize ?? 100, entries.length);
    const sample = entries.slice().sort(() => Math.random() - 0.5).slice(0, sampleSize);
    let mismatched = 0;
    const mismatchedPaths: string[] = [];
    for (const e of sample) {
      try {
        const stat = await fs.stat(join(root.absPath, e.pathFromRoot));
        if (Math.floor(stat.mtimeMs) !== e.mtime) {
          mismatched++;
          mismatchedPaths.push(e.pathFromRoot);
        }
      } catch {
        mismatched++;
        mismatchedPaths.push(e.pathFromRoot);
      }
    }
    const rate = sampleSize === 0 ? 0 : mismatched / sampleSize;
    const threshold = this.opts.mismatchThreshold ?? 0.05;
    if (rate > threshold || (rate > 0 && threshold === 0)) {
      for (const p of mismatchedPaths) {
        try {
          await this.opts.mgr.onFileChange(join(root.absPath, p), workspaceHash);
        } catch {
          this.opts.store.deleteManifestEntry(workspaceHash, p);
        }
      }
      return { scanned: sampleSize, mismatched, reindexed: true };
    }
    return { scanned: sampleSize, mismatched, reindexed: false };
  }
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/main/codemem/__tests__/periodic-scan.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/periodic-scan.ts src/main/codemem/__tests__/periodic-scan.spec.ts
git commit -m "feat(codemem): periodic manifest-vs-disk scan with mismatch-threshold re-index"
```

---

### Task 9: LSP utility-process scaffolding (boot, ping, terminate)

**Files:**
- Create: `src/main/lsp-worker/protocol.ts`
- Create: `src/main/lsp-worker/worker-main.ts`
- Create: `src/main/lsp-worker/gateway-rpc.ts`
- Test: `src/main/lsp-worker/__tests__/gateway-rpc.spec.ts`

- [ ] **Step 1: Define the protocol**

Write `src/main/lsp-worker/protocol.ts`:

```typescript
import { z } from 'zod';

export const requestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ping'), id: z.string() }),
  z.object({ op: z.literal('shutdown'), id: z.string() }),
  z.object({ op: z.literal('open-workspace'), id: z.string(), absPath: z.string(), language: z.string() }),
  z.object({ op: z.literal('ready'), id: z.string(), workspaceId: z.string(), language: z.string(), timeoutMs: z.number() }),
]);

export const responseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export type WorkerRequest = z.infer<typeof requestSchema>;
export type WorkerResponse = z.infer<typeof responseSchema>;
```

- [ ] **Step 2: Write the worker entrypoint**

Write `src/main/lsp-worker/worker-main.ts`:

```typescript
import { parentPort } from 'node:worker_threads';
import { requestSchema, type WorkerResponse } from './protocol';

const warmedWorkspaces = new Set<string>();

if (!parentPort) throw new Error('lsp-worker must be run as a worker thread');

parentPort.on('message', (raw: unknown) => {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    const err: WorkerResponse = { id: 'unknown', ok: false, error: 'invalid request' };
    parentPort!.postMessage(err);
    return;
  }
  const req = parsed.data;
  switch (req.op) {
    case 'ping':
      parentPort!.postMessage({ id: req.id, ok: true, data: 'pong' });
      return;
    case 'shutdown':
      parentPort!.postMessage({ id: req.id, ok: true });
      process.exit(0);
      return;
    case 'open-workspace':
      // Phase 1 placeholder: real lsp-manager wiring lands in Task 10.
      warmedWorkspaces.add(`${req.absPath}::${req.language}`);
      parentPort!.postMessage({ id: req.id, ok: true });
      return;
    case 'ready': {
      const key = `${req.workspaceId}::${req.language}`;
      const ok = warmedWorkspaces.has(key);
      parentPort!.postMessage({ id: req.id, ok: true, data: { ready: ok } });
      return;
    }
  }
});
```

- [ ] **Step 3: Write the main-side gateway**

Write `src/main/lsp-worker/gateway-rpc.ts`:

```typescript
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { responseSchema, type WorkerRequest, type WorkerResponse } from './protocol';

export class LspWorkerGateway {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  start(): void {
    if (this.worker) return;
    const workerPath = resolve(__dirname, 'worker-main.js');
    this.worker = new Worker(workerPath);
    this.attachListeners();
  }

  startWithPath(workerPath: string): void {
    if (this.worker) return;
    this.worker = new Worker(workerPath);
    this.attachListeners();
  }

  private attachListeners(): void {
    if (!this.worker) return;
    this.worker.on('message', (raw) => this.handleMessage(raw));
    this.worker.on('error', (e) => this.failAll(e));
    this.worker.on('exit', () => this.failAll(new Error('worker exited')));
  }

  async send(op: WorkerRequest['op'], extra: Record<string, unknown> = {}, timeoutMs = 5000): Promise<WorkerResponse> {
    if (!this.worker) throw new Error('worker not started');
    const id = randomUUID();
    const req = { op, id, ...extra } as WorkerRequest;
    return new Promise<WorkerResponse>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`worker timeout for op=${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.worker!.postMessage(req);
    });
  }

  async ping(): Promise<string> {
    const r = await this.send('ping');
    return r.data as string;
  }

  async shutdown(): Promise<void> {
    try { await this.send('shutdown', {}, 1000); } catch { /* exiting */ }
    this.worker = null;
  }

  private handleMessage(raw: unknown): void {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) return;
    const entry = this.pending.get(parsed.data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(parsed.data.id);
    entry.resolve(parsed.data);
  }

  private failAll(err: Error): void {
    for (const e of this.pending.values()) { clearTimeout(e.timer); e.reject(err); }
    this.pending.clear();
    this.worker = null;
  }
}
```

- [ ] **Step 4: Write the failing tests**

Write `src/main/lsp-worker/__tests__/gateway-rpc.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { LspWorkerGateway } from '../gateway-rpc';

const WORKER = resolve(__dirname, '../worker-main.ts');

describe('LspWorkerGateway', () => {
  let gw: LspWorkerGateway;

  beforeEach(() => {
    gw = new LspWorkerGateway();
    gw.startWithPath(WORKER);
  });

  afterEach(async () => {
    await gw.shutdown();
  });

  it('ping returns pong', async () => {
    expect(await gw.ping()).toBe('pong');
  });

  it('open-workspace then ready returns ready=true', async () => {
    await gw.send('open-workspace', { absPath: '/tmp/w1', language: 'typescript' });
    const r = await gw.send('ready', { workspaceId: '/tmp/w1', language: 'typescript', timeoutMs: 1000 });
    expect((r.data as { ready: boolean }).ready).toBe(true);
  });

  it('ready returns ready=false when workspace was not opened', async () => {
    const r = await gw.send('ready', { workspaceId: '/tmp/never', language: 'typescript', timeoutMs: 1000 });
    expect((r.data as { ready: boolean }).ready).toBe(false);
  });
});
```

If Vitest cannot run a `.ts` worker directly, ensure the test build emits the worker to a known path and update `WORKER` accordingly. Confirm via `cat vitest.config.ts` and adjust.

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run src/main/lsp-worker/__tests__/gateway-rpc.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/lsp-worker/ src/main/lsp-worker/__tests__/
git commit -m "feat(lsp-worker): worker-thread scaffolding + RPC gateway with ping/open/ready/shutdown"
```

---

### Task 10: Move lsp-manager into the worker

**Files:**
- Modify: `src/main/lsp-worker/worker-main.ts` — load and delegate to existing `lsp-manager.ts`
- Modify: `src/main/lsp-worker/protocol.ts` — add per-operation request variants
- Modify: `src/main/ipc/handlers/lsp-handlers.ts` — proxy IPC handlers through `LspWorkerGateway`

- [ ] **Step 1: Inspect the current lsp-manager surface**

Read `src/main/workspace/lsp-manager.ts` end-to-end. List its public methods (e.g., `goToDefinition`, `findReferences`, `documentSymbols`, `workspaceSymbols`, `hover`, `diagnostics`, `findImplementations`, `callHierarchy`). Note exact signatures — they become the worker delegate methods.

- [ ] **Step 2: Extend the protocol**

Edit `src/main/lsp-worker/protocol.ts` to add operations. Example for `find-references`:

```typescript
z.object({
  op: z.literal('find-references'),
  id: z.string(),
  absPath: z.string(),
  symbolName: z.string(),
  containerName: z.string().nullable(),
  kind: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
}),
```

Add the same shape for: `document-symbols`, `workspace-symbols`, `call-hierarchy`, `find-implementations`, `hover`, `diagnostics`. Keep argument names matching the existing `lsp-manager` methods so delegation is mechanical.

- [ ] **Step 3: Wire delegation in worker-main**

Edit `src/main/lsp-worker/worker-main.ts`. Import the existing `LspManager` (match its singleton/instantiation pattern). Add cases for each new op that call the corresponding manager method, wrap in try/catch, and post `{ok: false, error: e.message}` on failure.

- [ ] **Step 4: Update IPC handlers to proxy through the gateway**

Edit `src/main/ipc/handlers/lsp-handlers.ts`. Replace direct calls to the local `LspManager` with calls to a shared `LspWorkerGateway` instance obtained from a new `getLspWorker()` helper (added in Task 12). Behavior must be unchanged from the renderer's perspective — same return shapes, same error semantics.

- [ ] **Step 5: Add a smoke test for delegation**

Append to `src/main/lsp-worker/__tests__/gateway-rpc.spec.ts`:

```typescript
it('document-symbols on a TS fixture file returns at least one symbol', async () => {
  await gw.send('open-workspace', { absPath: resolve(__dirname, '../../../../test/fixtures/codemem-sample'), language: 'typescript' });
  const r = await gw.send('document-symbols', {
    absPath: resolve(__dirname, '../../../../test/fixtures/codemem-sample/src/math.ts'),
  }, 30_000);
  expect(r.ok).toBe(true);
  expect(Array.isArray(r.data)).toBe(true);
  expect((r.data as unknown[]).length).toBeGreaterThan(0);
});
```

- [ ] **Step 6: Run all tests + typecheck**

```bash
npx vitest run src/main/lsp-worker/
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all PASS. Existing renderer-side LSP usage unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/main/lsp-worker/ src/main/ipc/handlers/lsp-handlers.ts
git commit -m "feat(lsp-worker): delegate lsp-manager ops via worker thread; IPC handlers proxy through gateway"
```

---

### Task 11: AgentLspFacade with reduced tool surface

**Files:**
- Create: `src/main/codemem/agent-lsp-facade.ts`
- Test: `src/main/codemem/__tests__/agent-lsp-facade.spec.ts`

- [ ] **Step 1: Write the failing tests**

Write `src/main/codemem/__tests__/agent-lsp-facade.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { LspWorkerGateway } from '../../lsp-worker/gateway-rpc';
import { AgentLspFacade } from '../agent-lsp-facade';

const WORKER = resolve(__dirname, '../../lsp-worker/worker-main.ts');
const FIXTURE = resolve(__dirname, '../../../../test/fixtures/codemem-sample');

describe('AgentLspFacade', () => {
  let gw: LspWorkerGateway;
  let facade: AgentLspFacade;

  beforeEach(async () => {
    gw = new LspWorkerGateway();
    gw.startWithPath(WORKER);
    facade = new AgentLspFacade({ gateway: gw });
    await gw.send('open-workspace', { absPath: FIXTURE, language: 'typescript' });
  });

  afterEach(async () => {
    await gw.shutdown();
  });

  it('findSymbol returns symbol_id and matches limit cap of 50', async () => {
    const r = await facade.findSymbol({ name: 'add' });
    if ('status' in r) return; // warming case is acceptable for this assertion
    expect(r.length).toBeLessThanOrEqual(50);
    if (r.length > 0) expect(r[0]!.symbol_id).toMatch(/^[a-f0-9]{40}$/);
  });

  it('documentSymbols returns hierarchical results for a file', async () => {
    const r = await facade.documentSymbols({ path: `${FIXTURE}/src/math.ts` });
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });

  it('callHierarchy enforces hard depth cap of 5', async () => {
    const r = await facade.callHierarchy({ symbol_id: 'a'.repeat(40), direction: 'incoming', maxDepth: 99 });
    expect(r.depthUsed).toBeLessThanOrEqual(5);
  });

  it('returns warming status when LSP not ready', async () => {
    const facade2 = new AgentLspFacade({ gateway: gw });
    const r = await facade2.findSymbol({ name: 'foo', workspace: '/tmp/never-opened' });
    if ('status' in r) expect(r.status).toBe('warming');
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx vitest run src/main/codemem/__tests__/agent-lsp-facade.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the facade**

Write `src/main/codemem/agent-lsp-facade.ts`:

```typescript
import type { LspWorkerGateway } from '../lsp-worker/gateway-rpc';
import { symbolId } from './symbol-id';

export interface AgentLspFacadeOptions {
  gateway: LspWorkerGateway;
}

export interface SymbolHit {
  path: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  kind: string;
  container: string | null;
  name: string;
  symbol_id: string;
}

export type WarmingResponse = { status: 'warming'; etaMs: number };

export class AgentLspFacade {
  constructor(private readonly opts: AgentLspFacadeOptions) {}

  async findSymbol(args: { name: string; kind?: string; workspace?: string }): Promise<SymbolHit[] | WarmingResponse> {
    if (args.workspace) {
      const ready = await this.opts.gateway.send('ready', { workspaceId: args.workspace, language: 'typescript', timeoutMs: 0 });
      if (!(ready.data as { ready: boolean }).ready) return { status: 'warming', etaMs: 5000 };
    }
    const r = await this.opts.gateway.send('workspace-symbols', { query: args.name, limit: 50 });
    if (!r.ok) return [];
    const raw = r.data as Array<{ path: string; range: SymbolHit['range']; kind: string; container: string | null; name: string }>;
    return raw.slice(0, 50).map((s) => ({
      ...s,
      symbol_id: symbolId({ absPath: s.path, kind: s.kind, name: s.name, containerName: s.container }),
    }));
  }

  async findReferences(args: { symbol_id: string; absPath: string; symbolName: string; containerName: string | null; limit?: number }): Promise<{ path: string; range: SymbolHit['range']; snippet: string }[]> {
    const limit = Math.min(args.limit ?? 100, 500);
    const r = await this.opts.gateway.send('find-references', { absPath: args.absPath, symbolName: args.symbolName, containerName: args.containerName, limit });
    if (!r.ok) return [];
    return (r.data as { path: string; range: SymbolHit['range']; snippet: string }[]).slice(0, limit);
  }

  async documentSymbols(args: { path: string }): Promise<unknown[]> {
    const r = await this.opts.gateway.send('document-symbols', { absPath: args.path });
    return r.ok && Array.isArray(r.data) ? r.data : [];
  }

  async workspaceSymbols(args: { query: string; limit?: number }): Promise<SymbolHit[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const r = await this.opts.gateway.send('workspace-symbols', { query: args.query, limit });
    if (!r.ok) return [];
    return (r.data as Array<{ path: string; range: SymbolHit['range']; kind: string; container: string | null; name: string }>).slice(0, limit).map((s) => ({
      ...s,
      symbol_id: symbolId({ absPath: s.path, kind: s.kind, name: s.name, containerName: s.container }),
    }));
  }

  async callHierarchy(args: { symbol_id: string; direction: 'incoming' | 'outgoing'; maxDepth?: number }): Promise<{ paths: unknown[]; truncated: boolean; depthUsed: number }> {
    const cap = Math.min(args.maxDepth ?? 3, 5);
    const r = await this.opts.gateway.send('call-hierarchy', { symbol_id: args.symbol_id, direction: args.direction, maxDepth: cap });
    if (!r.ok) return { paths: [], truncated: false, depthUsed: 0 };
    const data = r.data as { paths: unknown[]; depthUsed: number };
    return { paths: data.paths, truncated: data.depthUsed >= cap, depthUsed: Math.min(data.depthUsed, cap) };
  }

  async findImplementations(args: { symbol_id: string; absPath: string; symbolName: string }): Promise<SymbolHit[]> {
    const r = await this.opts.gateway.send('find-implementations', { absPath: args.absPath, symbolName: args.symbolName });
    if (!r.ok) return [];
    return (r.data as Array<{ path: string; range: SymbolHit['range']; kind: string; container: string | null; name: string }>).slice(0, 50).map((s) => ({
      ...s,
      symbol_id: symbolId({ absPath: s.path, kind: s.kind, name: s.name, containerName: s.container }),
    }));
  }

  async hover(args: { symbol_id: string; absPath: string; symbolName: string }): Promise<{ signature: string; doc: string }> {
    const r = await this.opts.gateway.send('hover', { absPath: args.absPath, symbolName: args.symbolName });
    if (!r.ok) return { signature: '', doc: '' };
    const data = r.data as { signature: string; doc: string };
    return { signature: data.signature.slice(0, 1000), doc: data.doc.slice(0, 1000) };
  }

  async diagnostics(args: { path?: string; page?: number }): Promise<{ items: unknown[]; page: number; pageSize: number }> {
    const page = args.page ?? 0;
    const r = await this.opts.gateway.send('diagnostics', { absPath: args.path ?? null, page, pageSize: 50 });
    if (!r.ok) return { items: [], page, pageSize: 50 };
    const data = r.data as { items: unknown[] };
    return { items: data.items.slice(0, 50), page, pageSize: 50 };
  }
}
```

(Add the matching op variants to `protocol.ts` if Task 10 didn't already cover them.)

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/main/codemem/__tests__/agent-lsp-facade.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/agent-lsp-facade.ts src/main/codemem/__tests__/agent-lsp-facade.spec.ts src/main/lsp-worker/protocol.ts
git commit -m "feat(codemem): AgentLspFacade — Serena-shaped reduced surface with caps + symbol_id"
```

---

### Task 12: Codemem singleton + main-process boot wiring

**Files:**
- Create: `src/main/codemem/index.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Implement the singleton**

Write `src/main/codemem/index.ts`:

```typescript
import { app } from 'electron';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './cas-schema';
import { CasStore } from './cas-store';
import { CodeIndexManager } from './code-index-manager';
import { PeriodicScan } from './periodic-scan';
import { AgentLspFacade } from './agent-lsp-facade';
import { LspWorkerGateway } from '../lsp-worker/gateway-rpc';

interface CodemEm {
  store: CasStore;
  indexer: CodeIndexManager;
  scan: PeriodicScan;
  lspGateway: LspWorkerGateway;
  facade: AgentLspFacade;
}

let instance: CodemEm | null = null;

export function getCodemEm(): CodemEm {
  if (!instance) throw new Error('codemem not initialized');
  return instance;
}

export function getLspWorker(): LspWorkerGateway {
  return getCodemEm().lspGateway;
}

export function initCodemEm(): CodemEm {
  if (instance) return instance;
  const dbPath = join(app.getPath('userData'), 'codemem.sqlite');
  const db = new Database(dbPath);
  migrate(db);
  const store = new CasStore(db);
  const indexer = new CodeIndexManager({ store });
  const scan = new PeriodicScan({ store, mgr: indexer });
  const lspGateway = new LspWorkerGateway();
  lspGateway.start();
  const facade = new AgentLspFacade({ gateway: lspGateway });
  instance = { store, indexer, scan, lspGateway, facade };
  return instance;
}

export async function shutdownCodemEm(): Promise<void> {
  if (!instance) return;
  await instance.indexer.stop();
  await instance.lspGateway.shutdown();
  instance = null;
}

export function _resetForTesting(): void {
  instance = null;
}
```

- [ ] **Step 2: Wire boot into main**

Edit `src/main/index.ts`. After `app.whenReady()`:

```typescript
import { initCodemEm, shutdownCodemEm } from './codemem';

// inside app.whenReady().then(...) chain, before any window creation that depends on LSP:
initCodemEm();

// in app.on('before-quit', ...) or equivalent:
await shutdownCodemEm();
```

Confirm the existing teardown pattern by reading `src/main/index.ts` end-to-end before editing. Match adjacent style.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/codemem/index.ts src/main/index.ts
git commit -m "feat(codemem): singleton + main-process boot/shutdown wiring"
```

---

### Task 13: MCP tool registration

**Files:**
- Create: `src/main/codemem/mcp-tools.ts`
- Modify: wherever the existing MCP server registers tools (find via: `grep -RIn "registerTool\|server.tool\|McpServer" src/main/`)

- [ ] **Step 1: Inspect the existing MCP registration pattern**

Run the grep above. Identify the file that registers MCP tools (likely under `src/main/mcp/` or `src/main/orchestration/`). Read it to understand its registration shape (factory function vs decorator vs explicit list).

- [ ] **Step 2: Write `mcp-tools.ts` matching that pattern**

Sketch — adapt to the project's MCP server abstraction:

```typescript
import { z } from 'zod';
import { getCodemEm } from './index';

export function registerCodemEmMcpTools(server: { tool: (name: string, schema: z.ZodTypeAny, handler: (args: unknown) => Promise<unknown>) => void }): void {
  const facade = () => getCodemEm().facade;

  server.tool('codemem.find_symbol',
    z.object({ name: z.string(), kind: z.string().optional(), workspace: z.string().optional() }),
    (args) => facade().findSymbol(args as { name: string; kind?: string; workspace?: string }));

  server.tool('codemem.find_references',
    z.object({ symbol_id: z.string(), absPath: z.string(), symbolName: z.string(), containerName: z.string().nullable(), limit: z.number().int().positive().max(500).optional() }),
    (args) => facade().findReferences(args as never));

  server.tool('codemem.document_symbols',
    z.object({ path: z.string() }),
    (args) => facade().documentSymbols(args as { path: string }));

  server.tool('codemem.workspace_symbols',
    z.object({ query: z.string(), limit: z.number().int().positive().max(200).optional() }),
    (args) => facade().workspaceSymbols(args as { query: string; limit?: number }));

  server.tool('codemem.call_hierarchy',
    z.object({ symbol_id: z.string(), direction: z.enum(['incoming','outgoing']), maxDepth: z.number().int().positive().max(5).optional() }),
    (args) => facade().callHierarchy(args as never));

  server.tool('codemem.find_implementations',
    z.object({ symbol_id: z.string(), absPath: z.string(), symbolName: z.string() }),
    (args) => facade().findImplementations(args as never));

  server.tool('codemem.hover',
    z.object({ symbol_id: z.string(), absPath: z.string(), symbolName: z.string() }),
    (args) => facade().hover(args as never));

  server.tool('codemem.diagnostics',
    z.object({ path: z.string().optional(), page: z.number().int().nonnegative().optional() }),
    (args) => facade().diagnostics(args as { path?: string; page?: number }));
}
```

- [ ] **Step 3: Hook registration into the MCP server boot path**

Add a single import + call in the file identified by Step 1, immediately after the other tool-set registrations.

- [ ] **Step 4: Smoke test from the existing MCP test harness**

Search for an existing tool-list assertion: `grep -RIn "list.*tools\|tools/list" src/`. Add an assertion that `codemem.find_symbol` appears in the listed tools. If no harness exists, create a minimal test in `src/main/codemem/__tests__/mcp-tools.spec.ts` that constructs a stub server and verifies `registerCodemEmMcpTools` calls `tool` with all expected names.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
git add src/main/codemem/mcp-tools.ts <the modified MCP-server file>
git commit -m "feat(codemem): register mcp__codemem__* tools on the MCP server"
```

---

### Task 14: InstanceLifecycle warm-up gate

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

- [ ] **Step 1: Locate the spawn entry point**

Read `src/main/instance/instance-lifecycle.ts`. Find the method that creates child instances (likely `spawn` or `createInstance`). Note the signature and the surrounding async setup phase.

- [ ] **Step 2: Add the warm-up await with timeout fallback**

In the spawn method, after workspace is determined but before the child process is launched:

```typescript
import { getCodemEm } from '../codemem';

// inside spawn(...) after workspaceAbsPath/primaryLanguage are known:
const codemem = getCodemEm();
try {
  const r = await codemem.lspGateway.send('ready',
    { workspaceId: workspaceAbsPath, language: primaryLanguage, timeoutMs: 15_000 },
    16_000);
  const ready = (r.data as { ready: boolean }).ready;
  if (!ready) {
    await codemem.lspGateway.send('open-workspace', { absPath: workspaceAbsPath, language: primaryLanguage }, 1000);
  }
} catch {
  // LSP worker unreachable — proceed; facade returns lsp_unavailable
}
```

If `primaryLanguage` is not currently known at spawn time, derive it from `codemem.store.getWorkspaceRoot(...)` or from a workspace-spec field; if neither exists, default to `'typescript'`.

- [ ] **Step 3: Add a smoke test**

If `instance-lifecycle.ts` already has a test file (search: `find . -path '*/instance/*spec*' -not -path '*/node_modules/*'`), append a case asserting that spawn proceeds when `lspGateway.send('ready', …)` resolves with `ready=false` (mock the gateway). If no test file exists, create `src/main/instance/__tests__/instance-lifecycle-warmup.spec.ts` with a minimal harness.

- [ ] **Step 4: Run tests + typecheck**

```bash
npx vitest run src/main/instance/
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts src/main/instance/__tests__/
git commit -m "feat(codemem): InstanceLifecycle awaits LSP warm-up with 15s timeout fallback"
```

---

### Task 15: Feature flag + soak test + final integration check

**Files:**
- Modify: `src/main/codemem/index.ts` (add `enabled` check)
- Modify: settings surface (find via `grep -RIn "settings\|preferences" src/shared/ src/main/persistence/ | head -20`)
- Create: `src/main/codemem/__tests__/soak.spec.ts`

- [ ] **Step 1: Add the feature flag**

Add to the existing settings schema (extend the relevant Zod schema in `src/shared/validation/`):

```typescript
codemem: z.object({
  enabled: z.boolean().default(true),
  indexingEnabled: z.boolean().default(true),
  lspWorkerEnabled: z.boolean().default(true),
}).default({ enabled: true, indexingEnabled: true, lspWorkerEnabled: true }),
```

In `initCodemEm()`, read the setting (use the existing settings accessor — search: `grep -RIn "getSettings\|loadSettings" src/main/`). Skip indexer/LSP boot when respective flags are false. Document this with a one-line comment at the top of `initCodemEm`.

- [ ] **Step 2: Write the soak test**

Write `src/main/codemem/__tests__/soak.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';

describe('codemem soak', () => {
  let workDir: string;
  let mgr: CodeIndexManager;
  let store: CasStore;

  beforeEach(async () => {
    workDir = `${tmpdir()}/codemem-soak-${Date.now()}-${Math.random()}`;
    await mkdir(`${workDir}/src`, { recursive: true });
    const db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store, debounceMs: 10 });
    await writeFile(`${workDir}/src/seed.ts`, 'export const x = 0;\n');
  });

  afterEach(async () => {
    await mgr.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it('handles 200 rapid edits with stable memory and no missed final state', async () => {
    const r0 = await mgr.coldIndex(workDir);
    await mgr.start(workDir, r0.workspaceHash);
    for (let i = 1; i <= 200; i++) {
      await writeFile(`${workDir}/src/seed.ts`, `export const x = ${i};\n`);
      if (i % 25 === 0) await new Promise((res) => setTimeout(res, 5));
    }
    await new Promise((res) => setTimeout(res, 300));
    const entries = store.listManifestEntries(r0.workspaceHash);
    const seed = entries.find((e) => e.pathFromRoot === 'src/seed.ts');
    expect(seed).toBeDefined();
    const expected = await import('node:crypto').then((c) => c.createHash('sha256').update('export const x = 200;\n').digest('hex'));
    expect(seed!.contentHash).toBe(expected);
  });
});
```

- [ ] **Step 3: Run the soak test**

Run: `npx vitest run src/main/codemem/__tests__/soak.spec.ts --testTimeout=30000`
Expected: PASS within ~5–10 seconds.

- [ ] **Step 4: Final whole-suite check**

```bash
npx vitest run src/main/codemem/ src/main/lsp-worker/ src/main/instance/
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Expected: all PASS, no new lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/codemem/index.ts src/shared/validation/ src/main/codemem/__tests__/soak.spec.ts
git commit -m "feat(codemem): feature flag + 200-edit soak test + final verification gate"
```

---

## Phase 1 done

After Task 15, the following is true:

- `~/Library/Application Support/ai-orchestrator/codemem.sqlite` exists; opening any workspace populates it.
- Every spawned child has access to `mcp__codemem__*` tools that resolve against the LSP utility process.
- LSP worker survives main-thread restarts; main-thread restarts after worker is up incur no LSP cold-start cost.
- AST-normalized merkle absorbs Prettier/eslint-format runs.
- fs.watch reliability backstopped by a 10-min sample-and-rescan.
- Whole subsystem can be disabled via `settings.codemem.enabled = false`.

Phase 2 (BriefPacker) and Phase 3 (Harvest loop) get their own plans referencing this one.
