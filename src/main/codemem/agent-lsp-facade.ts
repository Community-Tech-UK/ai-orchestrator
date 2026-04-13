import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Diagnostic,
  HoverInfo,
  Location,
  SymbolKind,
} from '../workspace/lsp-manager';
import type { LspWorkerGateway } from '../lsp-worker/gateway-rpc';
import type { CasStore } from './cas-store';
import { symbolId } from './symbol-id';
import type { WorkspaceSymbolKind, WorkspaceSymbolRecord } from './types';
import type {
  CodememCallHierarchyNode,
  CodememDiagnosticsPage,
  CodememReferenceMatch,
  CodememResult,
  CodememSymbolMatch,
} from '../../shared/codemem-types';

export type WorkspaceLspState = 'idle' | 'warming' | 'ready' | 'lsp_unavailable';

export interface AgentLspFacadeOptions {
  store: CasStore;
  gateway: LspWorkerGateway;
  getWorkspaceLspState?: (workspaceHash: string) => WorkspaceLspState;
}

export class AgentLspFacade {
  constructor(private readonly opts: AgentLspFacadeOptions) {}

  async findSymbol(
    name: string,
    options: { workspacePath?: string; kind?: string; limit?: number } = {},
  ): Promise<CodememResult<CodememSymbolMatch[]>> {
    const workspace = this.resolveWorkspace(options.workspacePath);
    if (!workspace) {
      return { status: 'lsp_unavailable', message: 'No indexed workspace is available.' };
    }

    const symbols = this.opts.store.searchWorkspaceSymbols(workspace.workspaceHash, name, {
      kind: options.kind as WorkspaceSymbolKind | undefined,
      limit: Math.max(1, Math.min(options.limit ?? 50, 50)),
    });

    return {
      status: 'ok',
      data: symbols.map((symbol) => this.mapWorkspaceSymbol(workspace.absPath, symbol)),
    };
  }

  async workspaceSymbols(
    query: string,
    options: { workspacePath?: string; limit?: number } = {},
  ): Promise<CodememResult<CodememSymbolMatch[]>> {
    const workspace = this.resolveWorkspace(options.workspacePath);
    if (!workspace) {
      return { status: 'lsp_unavailable', message: 'No indexed workspace is available.' };
    }

    const symbols = this.opts.store.searchWorkspaceSymbols(workspace.workspaceHash, query, {
      limit: Math.max(1, Math.min(options.limit ?? 50, 200)),
    });

    return {
      status: 'ok',
      data: symbols.map((symbol) => this.mapWorkspaceSymbol(workspace.absPath, symbol)),
    };
  }

  async findReferences(
    symbolIdValue: string,
    options: { workspacePath?: string; limit?: number } = {},
  ): Promise<CodememResult<CodememReferenceMatch[]>> {
    const symbol = this.resolveWorkspaceSymbol(symbolIdValue, options.workspacePath);
    if (!symbol) {
      return { status: 'symbol_not_found', message: `Unknown symbol: ${symbolIdValue}` };
    }

    const workspaceState = this.getWorkspaceState(symbol.workspaceHash);
    if (workspaceState !== 'ready' && workspaceState !== 'idle') {
      return {
        status: workspaceState === 'warming' ? 'warming' : 'lsp_unavailable',
        etaMs: workspaceState === 'warming' ? 15_000 : undefined,
      };
    }

    const locations = await this.opts.gateway.findReferences(
      this.resolveSymbolPath(symbol),
      symbol.startLine,
      symbol.startCharacter,
      true,
    ) as Location[] | null;
    if (!locations) {
      return { status: 'lsp_unavailable', message: 'LSP references are unavailable.' };
    }

    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const data = await Promise.all(
      locations.slice(0, limit).map(async (location) => ({
        path: this.filePathFromUri(location.uri),
        range: location.range,
        snippet: await this.readSnippet(this.filePathFromUri(location.uri), location.range.start.line),
      })),
    );

    return { status: 'ok', data };
  }

  async documentSymbols(filePath: string): Promise<CodememResult<unknown>> {
    const data = await this.opts.gateway.getDocumentSymbols(filePath);
    if (data == null) {
      return { status: 'lsp_unavailable', message: 'Document symbols are unavailable.' };
    }

    return { status: 'ok', data };
  }

  async findImplementations(
    symbolIdValue: string,
    options: { workspacePath?: string; limit?: number } = {},
  ): Promise<CodememResult<CodememReferenceMatch[]>> {
    const symbol = this.resolveWorkspaceSymbol(symbolIdValue, options.workspacePath);
    if (!symbol) {
      return { status: 'symbol_not_found', message: `Unknown symbol: ${symbolIdValue}` };
    }

    const workspaceState = this.getWorkspaceState(symbol.workspaceHash);
    if (workspaceState !== 'ready' && workspaceState !== 'idle') {
      return {
        status: workspaceState === 'warming' ? 'warming' : 'lsp_unavailable',
        etaMs: workspaceState === 'warming' ? 15_000 : undefined,
      };
    }

    const locations = await this.opts.gateway.findImplementations(
      this.resolveSymbolPath(symbol),
      symbol.startLine,
      symbol.startCharacter,
    ) as Location[] | null;
    if (!locations) {
      return { status: 'lsp_unavailable', message: 'Implementations are unavailable.' };
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 50));
    const data = await Promise.all(
      locations.slice(0, limit).map(async (location) => ({
        path: this.filePathFromUri(location.uri),
        range: location.range,
        snippet: await this.readSnippet(this.filePathFromUri(location.uri), location.range.start.line),
      })),
    );

    return { status: 'ok', data };
  }

  async callHierarchy(
    symbolIdValue: string,
    options: { workspacePath?: string; direction: 'incoming' | 'outgoing'; maxDepth?: number },
  ): Promise<CodememResult<CodememCallHierarchyNode>> {
    const symbol = this.resolveWorkspaceSymbol(symbolIdValue, options.workspacePath);
    if (!symbol) {
      return { status: 'symbol_not_found', message: `Unknown symbol: ${symbolIdValue}` };
    }

    const workspaceState = this.getWorkspaceState(symbol.workspaceHash);
    if (workspaceState !== 'ready' && workspaceState !== 'idle') {
      return {
        status: workspaceState === 'warming' ? 'warming' : 'lsp_unavailable',
        etaMs: workspaceState === 'warming' ? 15_000 : undefined,
      };
    }

    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 3, 5));
    const root = await this.buildHierarchyNode(
      {
        name: symbol.name,
        kind: this.toLspSymbolKind(symbol.kind),
        uri: `file://${this.resolveSymbolPath(symbol)}`,
        range: {
          start: { line: symbol.startLine, character: symbol.startCharacter },
          end: {
            line: symbol.endLine ?? symbol.startLine,
            character: symbol.endCharacter ?? symbol.startCharacter,
          },
        },
        selectionRange: {
          start: { line: symbol.startLine, character: symbol.startCharacter },
          end: {
            line: symbol.endLine ?? symbol.startLine,
            character: symbol.endCharacter ?? symbol.startCharacter,
          },
        },
        containerName: symbol.containerName ?? undefined,
      },
      symbol.workspaceHash,
      options.direction,
      maxDepth,
      new Set([symbol.symbolId]),
    );

    return { status: 'ok', data: root };
  }

  async hover(
    symbolIdValue: string,
    options: { workspacePath?: string } = {},
  ): Promise<CodememResult<HoverInfo>> {
    const symbol = this.resolveWorkspaceSymbol(symbolIdValue, options.workspacePath);
    if (!symbol) {
      return { status: 'symbol_not_found', message: `Unknown symbol: ${symbolIdValue}` };
    }

    const hover = await this.opts.gateway.hover(
      this.resolveSymbolPath(symbol),
      symbol.startLine,
      symbol.startCharacter,
    ) as HoverInfo | null;
    if (!hover) {
      return { status: 'lsp_unavailable', message: 'Hover information is unavailable.' };
    }

    return {
      status: 'ok',
      data: {
        ...hover,
        contents: hover.contents.slice(0, 1000),
      },
    };
  }

  async diagnostics(
    filePath: string,
    options: { page?: number; pageSize?: number } = {},
  ): Promise<CodememResult<CodememDiagnosticsPage>> {
    const diagnostics = await this.opts.gateway.getDiagnostics(filePath) as Diagnostic[] | null;
    if (!diagnostics) {
      return { status: 'lsp_unavailable', message: 'Diagnostics are unavailable.' };
    }

    const page = Math.max(0, options.page ?? 0);
    const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 200));
    const start = page * pageSize;

    return {
      status: 'ok',
      data: {
        items: diagnostics.slice(start, start + pageSize),
        page,
        pageSize,
        total: diagnostics.length,
      },
    };
  }

  private async buildHierarchyNode(
    item: CallHierarchyItem,
    workspaceHash: string,
    direction: 'incoming' | 'outgoing',
    depthRemaining: number,
    seen: Set<string>,
  ): Promise<CodememCallHierarchyNode> {
    const pathFromUri = this.filePathFromUri(item.uri);
    const currentSymbolId = symbolId({
      absPath: pathFromUri,
      kind: item.kind,
      name: item.name,
      containerName: item.containerName ?? null,
    });
    const node: CodememCallHierarchyNode = {
      symbolId: currentSymbolId,
      path: pathFromUri,
      name: item.name,
      kind: item.kind,
      containerName: item.containerName ?? null,
      range: item.selectionRange,
      children: [],
    };

    if (depthRemaining <= 1) {
      return node;
    }

    const calls = (direction === 'incoming'
      ? await this.opts.gateway.getIncomingCalls(
          pathFromUri,
          item.selectionRange.start.line,
          item.selectionRange.start.character,
        )
      : await this.opts.gateway.getOutgoingCalls(
          pathFromUri,
          item.selectionRange.start.line,
          item.selectionRange.start.character,
        )) as CallHierarchyIncomingCall[] | CallHierarchyOutgoingCall[] | null;

    if (!calls) {
      return node;
    }

    for (const call of calls) {
      const targetItem = direction === 'incoming'
        ? (call as CallHierarchyIncomingCall).from
        : (call as CallHierarchyOutgoingCall).to;
      const targetId = symbolId({
        absPath: this.filePathFromUri(targetItem.uri),
        kind: targetItem.kind,
        name: targetItem.name,
        containerName: targetItem.containerName ?? null,
      });
      if (seen.has(targetId)) {
        continue;
      }

      seen.add(targetId);
      node.children.push(
        await this.buildHierarchyNode(targetItem, workspaceHash, direction, depthRemaining - 1, seen),
      );
    }

    return node;
  }

  private resolveWorkspaceSymbol(symbolIdValue: string, workspacePath?: string): WorkspaceSymbolRecord | null {
    const workspace = this.resolveWorkspace(workspacePath);
    if (!workspace) {
      return null;
    }

    return this.opts.store.getWorkspaceSymbol(workspace.workspaceHash, symbolIdValue);
  }

  private resolveWorkspace(workspacePath?: string) {
    if (workspacePath) {
      return this.opts.store.getWorkspaceRootByPath(this.normalizeWorkspacePath(workspacePath));
    }

    const roots = this.opts.store.listWorkspaceRoots();
    if (roots.length === 1) {
      return roots[0];
    }

    return null;
  }

  private resolveSymbolPath(symbol: WorkspaceSymbolRecord): string {
    const workspace = this.opts.store.getWorkspaceRoot(symbol.workspaceHash);
    if (!workspace) {
      throw new Error(`Missing workspace root for ${symbol.workspaceHash}`);
    }
    return path.join(workspace.absPath, symbol.pathFromRoot);
  }

  private mapWorkspaceSymbol(workspacePath: string, symbol: WorkspaceSymbolRecord): CodememSymbolMatch {
    return {
      symbolId: symbol.symbolId,
      path: path.join(workspacePath, symbol.pathFromRoot),
      name: symbol.name,
      kind: symbol.kind,
      containerName: symbol.containerName,
      range: {
        start: {
          line: symbol.startLine,
          character: symbol.startCharacter,
        },
        end: {
          line: symbol.endLine ?? symbol.startLine,
          character: symbol.endCharacter ?? symbol.startCharacter,
        },
      },
      signature: symbol.signature,
      docComment: symbol.docComment,
    };
  }

  private getWorkspaceState(workspaceHash: string): WorkspaceLspState {
    return this.opts.getWorkspaceLspState?.(workspaceHash) ?? 'idle';
  }

  private toLspSymbolKind(kind: WorkspaceSymbolKind): SymbolKind {
    switch (kind) {
      case 'type':
        return 'typeParameter';
      default:
        return kind;
    }
  }

  private normalizeWorkspacePath(workspacePath: string): string {
    return path.resolve(workspacePath);
  }

  private filePathFromUri(uri: string): string {
    return fileURLToPath(uri);
  }

  private async readSnippet(filePath: string, line: number): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.split('\n')[line] ?? '';
    } catch {
      return '';
    }
  }
}
