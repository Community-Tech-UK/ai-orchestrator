import Database from 'better-sqlite3';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { AgentLspFacade } from '../agent-lsp-facade';
import { workspaceHashForPath } from '../symbol-id';
import type { LspWorkerGateway } from '../../lsp-worker/gateway-rpc';
import type { Diagnostic, HoverInfo, Location } from '../../workspace/lsp-manager';

describe('AgentLspFacade', () => {
  let db: Database.Database;
  let store: CasStore;
  let workspacePath: string;
  let workspaceHash: string;

  beforeEach(async () => {
    workspacePath = path.join(tmpdir(), `codemem-facade-${Date.now()}-${Math.random()}`);
    workspaceHash = workspaceHashForPath(workspacePath);
    await mkdir(path.join(workspacePath, 'src'), { recursive: true });
    await writeFile(
      path.join(workspacePath, 'src/math.ts'),
      ['export function add(a, b) {', '  return a + b;', '}', ''].join('\n'),
    );
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    store.upsertWorkspaceRoot({
      workspaceHash,
      absPath: workspacePath,
      headCommit: null,
      primaryLanguage: 'typescript',
      lastIndexedAt: Date.now(),
      merkleRootHash: 'root-hash',
      pagerankJson: null,
    });
    store.replaceWorkspaceSymbolsForFile(workspaceHash, 'src/math.ts', [
      {
        workspaceHash,
        symbolId: 'sym-add',
        pathFromRoot: 'src/math.ts',
        name: 'add',
        kind: 'function',
        containerName: null,
        startLine: 0,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 1,
        signature: 'add(a, b)',
        docComment: 'Adds two numbers',
      },
    ]);
  });

  afterEach(async () => {
    db.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  function createGatewayMock(overrides: Partial<LspWorkerGateway> = {}): LspWorkerGateway {
    return {
      findReferences: vi.fn(),
      hover: vi.fn(),
      getDiagnostics: vi.fn(),
      getDocumentSymbols: vi.fn(),
      findImplementations: vi.fn(),
      getIncomingCalls: vi.fn(),
      getOutgoingCalls: vi.fn(),
      ...overrides,
    } as unknown as LspWorkerGateway;
  }

  it('findSymbol returns absolute paths from the workspace index', async () => {
    const facade = new AgentLspFacade({
      store,
      gateway: createGatewayMock(),
    });

    const result = await facade.findSymbol('add', { workspacePath });

    expect(result.status).toBe('ok');
    expect(result.data).toEqual([
      expect.objectContaining({
        symbolId: 'sym-add',
        path: path.join(workspacePath, 'src/math.ts'),
        name: 'add',
        kind: 'function',
      }),
    ]);
  });

  it('findReferences returns warming until the workspace LSP is ready', async () => {
    const gateway = createGatewayMock();
    const facade = new AgentLspFacade({
      store,
      gateway,
      getWorkspaceLspState: () => 'warming',
    });

    const result = await facade.findReferences('sym-add', { workspacePath });

    expect(result).toMatchObject({ status: 'warming', etaMs: 15_000 });
    expect(vi.mocked(gateway.findReferences)).not.toHaveBeenCalled();
  });

  it('hover truncates long hover content', async () => {
    const hover: HoverInfo = {
      contents: 'x'.repeat(1_500),
    };
    const gateway = createGatewayMock({
      hover: vi.fn().mockResolvedValue(hover),
    });
    const facade = new AgentLspFacade({
      store,
      gateway,
    });

    const result = await facade.hover('sym-add', { workspacePath });

    expect(result.status).toBe('ok');
    expect(result.data?.contents).toHaveLength(1_000);
  });

  it('diagnostics paginates worker results', async () => {
    const diagnostics: Diagnostic[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        severity: 'error',
        message: 'First',
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        severity: 'warning',
        message: 'Second',
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
        severity: 'warning',
        message: 'Third',
      },
    ];
    const gateway = createGatewayMock({
      getDiagnostics: vi.fn().mockResolvedValue(diagnostics),
    });
    const facade = new AgentLspFacade({
      store,
      gateway,
    });

    const result = await facade.diagnostics(path.join(workspacePath, 'src/math.ts'), {
      page: 1,
      pageSize: 2,
    });

    expect(result.status).toBe('ok');
    expect(result.data).toEqual({
      items: [diagnostics[2]],
      page: 1,
      pageSize: 2,
      total: 3,
    });
  });

  it('findImplementations maps returned locations to snippets', async () => {
    const filePath = path.join(workspacePath, 'src/math.ts');
    const locations: Location[] = [
      {
        uri: `file://${filePath}`,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 10 },
        },
      },
    ];
    const gateway = createGatewayMock({
      findImplementations: vi.fn().mockResolvedValue(locations),
    });
    const facade = new AgentLspFacade({
      store,
      gateway,
    });

    const result = await facade.findImplementations('sym-add', { workspacePath });

    expect(result.status).toBe('ok');
    expect(result.data).toEqual([
      {
        path: filePath,
        range: locations[0].range,
        snippet: 'export function add(a, b) {',
      },
    ]);
  });
});
