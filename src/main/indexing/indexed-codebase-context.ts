import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { getCodeRetrievalService } from '../codemem';
import { getContextWorkerClient } from '../instance/context-worker-client';
import { defaultStoreIdResolver } from './codebase-indexing-auto-defaults';
import { getTokenCounter } from '../rlm/token-counter';
import { callWithDeadline } from '../util/deadline';
import type { RlmContextStoreDto } from '../instance/rlm-worker-port';
import type {
  CodeRetrievalResult,
  CodeRetrievalSearchOptions,
} from '../codemem/code-retrieval-service';
import type { FastPathResult } from '../instance/instance-types';

const logger = getLogger('IndexedCodebaseContext');
const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_TOP_K = 5;
const DEFAULT_STORE_LOOKUP_DEADLINE_MS = 500;
const MIN_QUERY_CHARS = 3;

export interface IndexedCodebaseContextResult {
  sectionId: string;
  filePath: string;
  relativePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  matchType: 'exact' | 'bm25' | 'vector' | 'hybrid';
  language?: string;
  symbolName?: string;
}

export interface IndexedCodebaseContextInfo {
  context: string;
  tokens: number;
  storeId: string;
  workspacePath: string;
  results: IndexedCodebaseContextResult[];
  durationMs: number;
}

export interface IndexedCodebaseContextRequest {
  workspacePath: string;
  query: string;
  maxTokens?: number;
  topK?: number;
  storeLookupDeadlineMs?: number;
}

export interface IndexedCodebaseContextSearchTarget {
  search(options: CodeRetrievalSearchOptions): Promise<CodeRetrievalResult[]>;
}

export interface IndexedCodebaseContextManagerTarget {
  getStoreByInstance(instanceId: string): Promise<RlmContextStoreDto | undefined>;
  listStores(): Promise<RlmContextStoreDto[]>;
}

export interface IndexedCodebaseContextServiceOptions {
  contextManager?: IndexedCodebaseContextManagerTarget;
  search?: IndexedCodebaseContextSearchTarget;
  storeIdResolver?: (rootPath: string) => string;
}

export class IndexedCodebaseContextService {
  private readonly contextManager?: IndexedCodebaseContextManagerTarget;
  private readonly searchTarget?: IndexedCodebaseContextSearchTarget;
  private readonly storeIdResolver: (rootPath: string) => string;

  constructor(options: IndexedCodebaseContextServiceOptions = {}) {
    this.contextManager = options.contextManager;
    this.searchTarget = options.search;
    this.storeIdResolver = options.storeIdResolver ?? defaultStoreIdResolver;
  }

  async buildContext(
    request: IndexedCodebaseContextRequest,
  ): Promise<IndexedCodebaseContextInfo | null> {
    const query = request.query.trim();
    if (query.length < MIN_QUERY_CHARS) {
      return null;
    }

    const workspacePath = this.normalizePath(request.workspacePath);
    if (!workspacePath) {
      return null;
    }

    const search = this.getSearchTarget();
    if (!search) {
      return null;
    }

    const fallbackStoreId = this.storeIdResolver(workspacePath);
    const storeId = await callWithDeadline(
      () => this.resolveStoreId(workspacePath, fallbackStoreId),
      {
        ms: normalizeLookupDeadline(request.storeLookupDeadlineMs),
        fallback: fallbackStoreId,
        onTimeout: () => logger.debug('RLM worker store lookup timed out for indexed context', {
          workspacePath,
        }),
        onError: (error) => logger.debug('RLM worker store lookup unavailable for indexed context', {
          workspacePath,
          error: error instanceof Error ? error.message : String(error),
        }),
      },
    );
    const startedAt = Date.now();
    let rawResults: CodeRetrievalResult[];
    try {
      rawResults = await search.search({
        workspacePath,
        query,
        limit: request.topK ?? DEFAULT_TOP_K,
        maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
    } catch (error) {
      logger.warn('Indexed codebase search failed', {
        workspacePath,
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (rawResults.length === 0) {
      return null;
    }

    const results = rawResults.map((result) => this.normalizeResult(result, workspacePath));
    const context = this.renderResults(results, request.maxTokens ?? DEFAULT_MAX_TOKENS);
    if (!context) {
      return null;
    }

    return {
      context,
      tokens: estimateTokens(context),
      storeId,
      workspacePath,
      results,
      durationMs: Date.now() - startedAt,
    };
  }

  async buildFastPathResult(
    request: IndexedCodebaseContextRequest,
  ): Promise<FastPathResult | null> {
    const context = await this.buildContext(request);
    if (!context) {
      return null;
    }

    const lines = context.results.map((result) => {
      const firstLine = result.content.split('\n').find((line) => line.trim())?.trim() ?? '';
      const line = result.startLine > 0 ? result.startLine : 1;
      return `${result.relativePath}:${line}: ${firstLine}`;
    });

    return {
      mode: 'indexed-codebase',
      command: 'codebase-index',
      args: ['search', request.query.trim()],
      totalMatches: context.results.length,
      lines,
      rawOutput: lines.join('\n'),
      cwd: context.workspacePath,
    };
  }

  formatContextBlock(context: IndexedCodebaseContextInfo | null): string | null {
    if (!context) {
      return null;
    }

    return [
      '[Indexed Codebase Context]',
      'Source: Harness indexed codebase search',
      [
        'This context was selected from the persisted codebase index.',
        'Use it as a starting point and verify important details against files before editing.',
      ].join(' '),
      context.context,
      '[End Indexed Codebase Context]',
    ].join('\n');
  }

  private async resolveStoreId(
    workspacePath: string,
    fallbackStoreId: string,
  ): Promise<string> {
    const manager = this.getContextManager();
    if (!manager) {
      return fallbackStoreId;
    }

    const byInstance = await manager.getStoreByInstance(fallbackStoreId);
    if (byInstance) {
      return byInstance.id;
    }

    const stores = await manager.listStores();
    return stores.find((store) => {
      const config = store.config;
      if (config?.['kind'] !== 'codebase-auto') {
        return false;
      }
      const rootPath = config['rootPath'];
      return typeof rootPath === 'string' && this.normalizePath(rootPath) === workspacePath;
    })?.id ?? fallbackStoreId;
  }

  private normalizeResult(
    result: CodeRetrievalResult,
    workspacePath: string,
  ): IndexedCodebaseContextResult {
    return {
      sectionId: `${result.relativePath}:${result.startLine}:${result.endLine}`,
      filePath: result.absolutePath,
      relativePath: result.relativePath,
      content: result.content,
      startLine: result.startLine,
      endLine: result.endLine,
      score: result.score,
      matchType: result.source === 'symbol' ? 'hybrid' : 'bm25',
      language: result.language,
      symbolName: result.symbolName ?? undefined,
    };
  }

  private renderResults(
    results: IndexedCodebaseContextResult[],
    maxTokens: number,
  ): string {
    const maxChars = Math.max(200, maxTokens * 4);
    const lines: string[] = [];

    for (const result of results) {
      const location = formatLocation(result);
      const heading = `- ${location} (${result.matchType}, score ${result.score.toFixed(3)})`;
      const fenced = [
        heading,
        '```' + (result.language ?? ''),
        result.content.trim(),
        '```',
      ].join('\n');
      const candidate = [...lines, fenced].join('\n\n');
      if (candidate.length > maxChars) {
        if (lines.length === 0) {
          return trimText(fenced, maxChars);
        }
        break;
      }
      lines.push(fenced);
    }

    return lines.join('\n\n');
  }

  private getContextManager(): IndexedCodebaseContextManagerTarget | null {
    if (this.contextManager) {
      return this.contextManager;
    }
    try {
      const port = getContextWorkerClient();
      return {
        getStoreByInstance: (instanceId) => port.invokeRlm({
          kind: 'get-store-by-instance',
          instanceId,
        }),
        listStores: () => port.invokeRlm({ kind: 'list-stores' }),
      };
    } catch (error) {
      logger.debug('RLM context worker unavailable for indexed codebase context', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private getSearchTarget(): IndexedCodebaseContextSearchTarget | null {
    if (this.searchTarget) {
      return this.searchTarget;
    }
    try {
      return getCodeRetrievalService();
    } catch (error) {
      logger.debug('Codemem retrieval unavailable for indexed codebase context', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private normalizePath(candidate: string): string | null {
    try {
      const trimmed = candidate.trim();
      return trimmed ? path.resolve(trimmed) : null;
    } catch {
      return null;
    }
  }
}

function normalizeLookupDeadline(candidate: number | undefined): number {
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
    ? Math.floor(candidate)
    : DEFAULT_STORE_LOOKUP_DEADLINE_MS;
}

function formatLocation(result: IndexedCodebaseContextResult): string {
  if (result.startLine > 0 && result.endLine > 0 && result.endLine !== result.startLine) {
    return `${result.relativePath}:${result.startLine}-${result.endLine}`;
  }
  if (result.startLine > 0) {
    return `${result.relativePath}:${result.startLine}`;
  }
  return result.relativePath;
}

function estimateTokens(text: string): number {
  return getTokenCounter().countTokens(text);
}

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n... [truncated]`;
}

let indexedCodebaseContextInstance: IndexedCodebaseContextService | null = null;

export function getIndexedCodebaseContextService(): IndexedCodebaseContextService {
  indexedCodebaseContextInstance ??= new IndexedCodebaseContextService();
  return indexedCodebaseContextInstance;
}

export function resetIndexedCodebaseContextServiceForTesting(): void {
  indexedCodebaseContextInstance = null;
}
