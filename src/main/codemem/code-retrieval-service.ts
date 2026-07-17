import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { CasStore } from './cas-store';
import type { IndexWorkerGateway } from './index-worker-gateway';
import { inferLanguage } from './code-index-manager';
import { searchHydratedChunks, type CodeRetrievalResult } from './workspace-chunk-search';
import { sanitizeRetrievalQuery } from '../memory/retrieval-eval/query-sanitizer';
import { getRecallTraceStore } from '../memory/retrieval-eval/recall-trace-store';

export type { CodeRetrievalResult };

export interface CodeRetrievalSearchOptions {
  workspacePath: string;
  query: string;
  limit?: number;
  maxTokens?: number;
}

/** The index-worker gateway surface this service depends on. */
type IndexSearchGateway = Pick<IndexWorkerGateway, 'warmWorkspace' | 'searchWorkspaceChunks'>;
type LazyCodememDependency = {
  store: CasStore;
  indexWorkerGateway: IndexSearchGateway;
};

export interface CodeRetrievalServiceOptions {
  store?: CasStore;
  indexWorkerGateway?: IndexSearchGateway;
  runFallbackSearch?: (
    workspacePath: string,
    query: string,
    limit: number,
  ) => Promise<CodeRetrievalResult[]>;
}

export class CodeRetrievalService {
  private readonly store?: CasStore;
  private readonly indexWorkerGateway?: IndexSearchGateway;
  private readonly codemem?: LazyCodememDependency;
  private readonly runFallbackSearchFn: (
    workspacePath: string,
    query: string,
    limit: number,
  ) => Promise<CodeRetrievalResult[]>;

  constructor(options: CodeRetrievalServiceOptions = {}) {
    const codemem = !options.store && !options.indexWorkerGateway ? getCodememLazy() : null;
    this.store = options.store;
    this.indexWorkerGateway = options.indexWorkerGateway ?? codemem?.indexWorkerGateway;
    this.codemem = codemem ?? undefined;
    this.runFallbackSearchFn = options.runFallbackSearch ?? runRipgrepFallbackSearch;
  }

  async search(options: CodeRetrievalSearchOptions): Promise<CodeRetrievalResult[]> {
    const rawQuery = options.query.trim();
    if (rawQuery.length < 2) return [];

    // WS16: recover search intent from over-long pasted queries before FTS.
    const sanitized = sanitizeRetrievalQuery(rawQuery);
    const query = sanitized.query;
    if (query.length < 2) return [];

    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 8), 50));
    const workspacePath = path.resolve(options.workspacePath);
    const results = await this.searchInternal(query, workspacePath, limit, options.maxTokens);
    // WS16: recall trace (raw + sanitized retained locally for offline analysis).
    try {
      getRecallTraceStore().record({
        surface: 'codemem',
        query,
        rawQuery: sanitized.sanitized ? rawQuery : undefined,
        sanitizedQuery: sanitized.sanitized ? query : undefined,
        returned: results.map((r) => ({ id: r.relativePath, score: r.score })),
      });
    } catch { /* tracing is best-effort observability */ }
    return results;
  }

  private async searchInternal(
    query: string,
    workspacePath: string,
    limit: number,
    maxTokens: number | undefined,
  ): Promise<CodeRetrievalResult[]> {
    const options = { maxTokens };

    // Preferred path: run the FTS + chunk hydration in the index worker, off the
    // main event loop. The gateway returns null on timeout/degradation (→ ripgrep)
    // and `{ indexed: false }` when the workspace has no index yet.
    if (this.indexWorkerGateway?.searchWorkspaceChunks) {
      const response = await this.indexWorkerGateway.searchWorkspaceChunks(workspacePath, query, limit);
      if (response?.indexed && response.results.length > 0) {
        return response.results.slice(0, limit).map((r) => this.trimResult(r, options.maxTokens));
      }
      if (response && !response.indexed) {
        // Warm in the background so the next search hits the index; serve ripgrep
        // now rather than blocking this request on a cold index.
        void this.indexWorkerGateway.warmWorkspace?.(workspacePath).catch(() => undefined);
      }
      // indexed-but-no-hits, not-indexed, or worker unavailable → ripgrep.
      // Deliberately never run a synchronous main-thread FTS here: that is the
      // stall this offload removes.
      return this.fallbackSearch(workspacePath, query, limit, options.maxTokens);
    }

    // No worker search available (tests / degraded construction): use the
    // synchronous in-process store if present, mirroring the legacy behaviour.
    const store = this.store ?? this.codemem?.store;
    if (store) {
      let local = searchHydratedChunks(store, workspacePath, query, limit);
      if (!local.indexed) {
        await this.indexWorkerGateway?.warmWorkspace?.(workspacePath, 2500).catch(() => undefined);
        local = searchHydratedChunks(store, workspacePath, query, limit);
      }
      if (local.results.length > 0) {
        return local.results.slice(0, limit).map((r) => this.trimResult(r, options.maxTokens));
      }
    }

    return this.fallbackSearch(workspacePath, query, limit, options.maxTokens);
  }

  private async fallbackSearch(
    workspacePath: string,
    query: string,
    limit: number,
    maxTokens?: number,
  ): Promise<CodeRetrievalResult[]> {
    const fallback = await this.runFallbackSearchFn(workspacePath, query, limit);
    return fallback.slice(0, limit).map((result) => this.trimResult(result, maxTokens));
  }

  private trimResult(result: CodeRetrievalResult, maxTokens?: number): CodeRetrievalResult {
    const maxChars = Math.max(256, Math.min((maxTokens ?? 900) * 4, 12_000));
    if (result.content.length <= maxChars) {
      return result;
    }
    return {
      ...result,
      content: result.content.slice(0, maxChars),
    };
  }
}

async function runRipgrepFallbackSearch(
  workspacePath: string,
  query: string,
  limit: number,
): Promise<CodeRetrievalResult[]> {
  return await new Promise((resolve) => {
    const child = spawn('rg', [
      '-n',
      '--no-heading',
      '-S',
      '--glob', '!.angular/**',
      '--glob', '!.cache/**',
      '--glob', '!node_modules/**',
      '--glob', '!dist/**',
      '--glob', '!build/**',
      '--glob', '!.git/**',
      '--glob', '!cache/**',
      '--glob', '!coverage/**',
      '--glob', '!libraries/**',
      '--glob', '!out/**',
      '--glob', '!target/**',
      '--glob', '!vendor/**',
      '--glob', '!venv/**',
      '--glob', '!.venv/**',
      '--glob', '!**/*.bundle.css',
      '--glob', '!**/*.bundle.js',
      '--glob', '!**/*.lock',
      '--glob', '!**/*.map',
      '--glob', '!**/*.min.css',
      '--glob', '!**/*.min.js',
      '--glob', '!package-lock.json',
      '--glob', '!pnpm-lock.yaml',
      '--glob', '!yarn.lock',
      query,
      '.',
    ], {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timeout = setTimeout(() => {
      child.kill();
    }, 2500);
    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 256 * 1024) {
        stdout += chunk.slice(0, 256 * 1024 - stdout.length);
      }
    });
    child.on('close', () => {
      clearTimeout(timeout);
      resolve(parseRipgrepOutput(workspacePath, stdout, limit));
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve([]);
    });
  });
}

function parseRipgrepOutput(
  workspacePath: string,
  stdout: string,
  limit: number,
): CodeRetrievalResult[] {
  const results: CodeRetrievalResult[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    const relativePath = match[1].replace(/^\.\//, '');
    const lineNumber = Number(match[2]);
    const content = match[3];
    results.push({
      workspacePath,
      relativePath,
      absolutePath: path.join(workspacePath, relativePath),
      content,
      startLine: lineNumber,
      endLine: lineNumber,
      score: 0,
      source: 'grepFallback',
      language: inferLanguage(relativePath),
      symbolName: null,
      stale: true,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function getCodememLazy(): {
  store: CasStore;
  indexWorkerGateway: IndexSearchGateway;
} {
  // Avoid a static import cycle: codemem/index.ts re-exports this service.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('./index') as {
    getCodemem: () => {
      store: CasStore;
      indexWorkerGateway: IndexSearchGateway;
    };
  };
  return module.getCodemem();
}

let codeRetrievalService: CodeRetrievalService | null = null;

export function getCodeRetrievalService(): CodeRetrievalService {
  if (!codeRetrievalService) {
    codeRetrievalService = new CodeRetrievalService();
  }
  return codeRetrievalService;
}

export function resetCodeRetrievalServiceForTesting(): void {
  codeRetrievalService = null;
}
