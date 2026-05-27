import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { CasStore } from './cas-store';
import type { IndexWorkerGateway } from './index-worker-gateway';
import { inferLanguage } from './code-index-manager';

export interface CodeRetrievalSearchOptions {
  workspacePath: string;
  query: string;
  limit?: number;
  maxTokens?: number;
}

export interface CodeRetrievalResult {
  workspacePath: string;
  relativePath: string;
  absolutePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: 'symbol' | 'fts' | 'grepFallback';
  language: string;
  symbolName: string | null;
  stale: boolean;
}

export interface CodeRetrievalServiceOptions {
  store?: CasStore;
  indexWorkerGateway?: Pick<IndexWorkerGateway, 'warmWorkspace'>;
  runFallbackSearch?: (
    workspacePath: string,
    query: string,
    limit: number,
  ) => Promise<CodeRetrievalResult[]>;
}

export class CodeRetrievalService {
  private readonly store: CasStore;
  private readonly indexWorkerGateway?: Pick<IndexWorkerGateway, 'warmWorkspace'>;
  private readonly runFallbackSearchFn: (
    workspacePath: string,
    query: string,
    limit: number,
  ) => Promise<CodeRetrievalResult[]>;

  constructor(options: CodeRetrievalServiceOptions = {}) {
    const codemem = options.store ? null : getCodememLazy();
    this.store = options.store ?? codemem!.store;
    this.indexWorkerGateway = options.indexWorkerGateway ?? codemem?.indexWorkerGateway;
    this.runFallbackSearchFn = options.runFallbackSearch ?? runRipgrepFallbackSearch;
  }

  async search(options: CodeRetrievalSearchOptions): Promise<CodeRetrievalResult[]> {
    const query = options.query.trim();
    if (query.length < 2) return [];

    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 8), 50));
    const workspacePath = path.resolve(options.workspacePath);
    let workspaceRoot = this.store.getWorkspaceRootByPath(workspacePath);

    if (!workspaceRoot) {
      await this.indexWorkerGateway?.warmWorkspace(workspacePath, 2500).catch(() => undefined);
      workspaceRoot = this.store.getWorkspaceRootByPath(workspacePath);
    }

    if (!workspaceRoot) {
      const fallback = await this.runFallbackSearchFn(workspacePath, query, limit);
      return fallback.slice(0, limit).map((result) => this.trimResult(result, options.maxTokens));
    }

    const hits = this.store.searchWorkspaceChunks(workspaceRoot.workspaceHash, query, limit * 2);
    const results: CodeRetrievalResult[] = [];
    for (const hit of hits) {
      const chunk = this.store.getChunk(hit.contentHash);
      if (!chunk) continue;
      results.push(this.trimResult({
        workspacePath,
        relativePath: hit.pathFromRoot,
        absolutePath: path.join(workspacePath, hit.pathFromRoot),
        content: chunk.rawText,
        startLine: hit.startLine,
        endLine: hit.endLine,
        score: hit.score,
        source: 'fts',
        language: hit.language,
        symbolName: hit.name || null,
        stale: false,
      }, options.maxTokens));
      if (results.length >= limit) {
        break;
      }
    }

    if (results.length > 0) {
      return results;
    }

    const fallback = await this.runFallbackSearchFn(workspacePath, query, limit);
    return fallback.slice(0, limit).map((result) => this.trimResult(result, options.maxTokens));
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
  indexWorkerGateway: Pick<IndexWorkerGateway, 'warmWorkspace'>;
} {
  // Avoid a static import cycle: codemem/index.ts re-exports this service.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('./index') as {
    getCodemem: () => {
      store: CasStore;
      indexWorkerGateway: Pick<IndexWorkerGateway, 'warmWorkspace'>;
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
