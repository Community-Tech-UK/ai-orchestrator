/**
 * RepoMapService — E14: ranked, token-budgeted repo-map injection.
 *
 * Builds a compact map of the project's most important files and their top
 * symbols so that a fresh root session has structural context without reading
 * everything. Injected into the system prompt at session start.
 *
 * ## Ranking algorithm
 * When the codemem CasStore has an indexed workspace we rank by a composite
 * score computed entirely from already-stored data (no extra I/O):
 *
 *   score = chunkCount * BASE_WEIGHT
 *         + pathBonus(path)     // entry-points, config, docs
 *
 * `chunkCount` is a good proxy for "how much named structure a file defines":
 * a 5-function utility scores higher than a 200-line flat script with no
 * named chunks. The path bonuses push well-known structural files to the top
 * regardless of chunk density.
 *
 * When the workspace is NOT yet indexed (or codemem is disabled) the service
 * falls back to a pure filesystem walk: it scores files using path heuristics
 * only and emits `{ text, stats: { ...fallback: true } }`.
 *
 * ## Token budget
 * Each file line is measured with the shared token estimator used by context
 * utilities. Files are appended in rank order until the budget would be
 * exceeded; the remainder is silently dropped and reflected in
 * `stats.truncated`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { DEFAULT_CODE_INDEX_IGNORES } from '../codemem/code-index-watcher';
import { workspaceHashForPath } from '../codemem/symbol-id';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';

// ─── tunables ────────────────────────────────────────────────────────────────

/** Default token budget (~2 000 tokens ≈ 8 000 chars). */
export const DEFAULT_REPO_MAP_TOKEN_BUDGET = 2_000;

/** Maximum files to include even if the budget allows more. */
const MAX_FILES_IN_MAP = 120;

/** Absolute file-size ceiling for filesystem-walk fallback. */
const MAX_FILE_BYTES_WALK = 10 * 1024 * 1024;

// ─── path-bonus lookup table ─────────────────────────────────────────────────

const ENTRY_POINT_BONUS = 60;
const CONFIG_BONUS = 40;
const DOC_BONUS = 20;
const TYPES_BONUS = 15;
const TEST_PENALTY = -10;

const ENTRY_POINT_NAMES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'main.ts', 'main.tsx', 'main.js',
  'app.ts', 'app.tsx', 'app.js', 'server.ts', 'server.js',
]);

const CONFIG_GLOBS = [
  /^package\.json$/,
  /^tsconfig.*\.json$/,
  /^vite\.config\./,
  /^vitest\.config\./,
  /^webpack\.config\./,
  /^rollup\.config\./,
  /^babel\.config\./,
  /^jest\.config\./,
  /^eslint\.config\./,
  /^\.eslintrc/,
  /^pyproject\.toml$/,
  /^setup\.py$/,
  /^Cargo\.toml$/,
  /^go\.mod$/,
  /^Makefile$/,
  /^Dockerfile$/,
];

const DOC_NAMES = /^readme/i;
const TYPES_NAMES = /\.(types|model|schema|interface)\.(ts|tsx)$/i;
const TEST_NAMES = /\.(spec|test)\.(ts|tsx|js|jsx)$/i;

function pathBonus(filePath: string): number {
  const base = path.basename(filePath);

  if (ENTRY_POINT_NAMES.has(base)) return ENTRY_POINT_BONUS;
  if (DOC_NAMES.test(base)) return DOC_BONUS;
  if (TYPES_NAMES.test(base)) return TYPES_BONUS;
  if (TEST_NAMES.test(base)) return TEST_PENALTY;
  for (const re of CONFIG_GLOBS) {
    if (re.test(base)) return CONFIG_BONUS;
  }

  return 0;
}

// ─── public interfaces ───────────────────────────────────────────────────────

export interface RepoMapOptions {
  projectPath: string;
  /** Token budget (default: DEFAULT_REPO_MAP_TOKEN_BUDGET). */
  tokenBudget?: number;
}

export interface RepoMapStats {
  filesConsidered: number;
  filesIncluded: number;
  truncated: boolean;
  fallback: boolean;
  tokensUsed: number;
}

export interface RepoMapResult {
  text: string;
  stats: RepoMapStats;
}

// ─── internal ────────────────────────────────────────────────────────────────

interface RankedFile {
  relativePath: string;
  score: number;
  /** Top symbol names (up to 8). Empty for fallback mode. */
  symbols: string[];
}

/**
 * Minimal surface of CasStore that RepoMapService needs.
 * Defined here so tests can inject a plain object without importing CasStore.
 */
export interface RepoMapStoreAccessor {
  getWorkspaceRootByPath(absPath: string): { workspaceHash: string } | null;
  listManifestEntries(workspaceHash: string): { pathFromRoot: string }[];
  listWorkspaceSymbols(
    workspaceHash: string,
  ): { pathFromRoot: string; name: string; kind: string }[];
}

/** Lazy accessor to CasStore — avoids circular-import at module load time. */
function getCasStoreLazy(): RepoMapStoreAccessor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCodemem } = require('../codemem/index') as {
      getCodemem: () => { store: RepoMapStoreAccessor } | null;
    };
    return getCodemem()?.store ?? null;
  } catch {
    return null;
  }
}

function estimateTokens(text: string): number {
  return sharedEstimateTokens(text);
}

// ─── RepoMapService ───────────────────────────────────────────────────────────

export interface RepoMapServiceOptions {
  /**
   * Injectable store accessor for testing. When omitted, the service uses
   * the live codemem CasStore via a lazy require.
   */
  storeAccessor?: RepoMapStoreAccessor | null;
}

export class RepoMapService {
  private readonly storeAccessorOverride: RepoMapStoreAccessor | null | undefined;

  constructor(options: RepoMapServiceOptions = {}) {
    // undefined means "use lazy default"; null means "force fallback"
    this.storeAccessorOverride = options.storeAccessor;
  }

  /** Build a compact repo map within the given token budget. */
  async buildRepoMap(options: RepoMapOptions): Promise<RepoMapResult> {
    const tokenBudget = options.tokenBudget ?? DEFAULT_REPO_MAP_TOKEN_BUDGET;
    const projectPath = path.resolve(options.projectPath);

    // Try index-backed ranking first.
    const indexResult = await this.buildFromIndex(projectPath, tokenBudget);
    if (indexResult) {
      return indexResult;
    }

    // Fallback: filesystem walk + path-heuristic ranking.
    return this.buildFromFilesystem(projectPath, tokenBudget);
  }

  // ── index-backed path ──────────────────────────────────────────────────────

  private async buildFromIndex(
    projectPath: string,
    tokenBudget: number,
  ): Promise<RepoMapResult | null> {
    const store =
      this.storeAccessorOverride !== undefined
        ? this.storeAccessorOverride
        : getCasStoreLazy();
    if (!store) {
      return null;
    }

    const workspaceHash = workspaceHashForPath(projectPath);
    const workspaceRoot = store.getWorkspaceRootByPath(projectPath);
    if (!workspaceRoot) {
      // Not indexed yet.
      return null;
    }

    const manifestEntries = store.listManifestEntries(workspaceHash);
    if (manifestEntries.length === 0) {
      return null;
    }

    // Build per-file chunk count from workspace_chunks via symbols listing
    // (listWorkspaceSymbols is already available and includes per-file info).
    const symbolsByFile = new Map<string, string[]>();
    const symbols = store.listWorkspaceSymbols(workspaceHash);
    for (const sym of symbols) {
      const arr = symbolsByFile.get(sym.pathFromRoot) ?? [];
      // Keep the most important kinds up front (class/interface/function/type)
      if (['class', 'interface', 'function', 'type', 'enum'].includes(sym.kind)) {
        arr.unshift(sym.name);
      } else {
        arr.push(sym.name);
      }
      symbolsByFile.set(sym.pathFromRoot, arr);
    }

    const ranked: RankedFile[] = manifestEntries.map((entry) => {
      const fileSymbols = symbolsByFile.get(entry.pathFromRoot) ?? [];
      // Deduplicate while preserving order
      const uniqueSymbols = [...new Set(fileSymbols)].slice(0, 8);
      const score = uniqueSymbols.length + pathBonus(entry.pathFromRoot);
      return {
        relativePath: entry.pathFromRoot,
        score,
        symbols: uniqueSymbols,
      };
    });

    return this.renderMap(ranked, tokenBudget, false);
  }

  // ── filesystem-walk fallback ───────────────────────────────────────────────

  private async buildFromFilesystem(
    projectPath: string,
    tokenBudget: number,
  ): Promise<RepoMapResult> {
    const ig = ignore().add(['.gitignore', ...DEFAULT_CODE_INDEX_IGNORES]);
    try {
      const gitignoreText = await fs.readFile(
        path.join(projectPath, '.gitignore'),
        'utf8',
      );
      ig.add(gitignoreText);
    } catch {
      // No .gitignore — fine.
    }

    const files = await this.walkFiles(projectPath, projectPath, ig);

    const ranked: RankedFile[] = [];
    for (const absolutePath of files) {
      const relativePath = path
        .relative(projectPath, absolutePath)
        .split(path.sep)
        .join('/');
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.size > MAX_FILE_BYTES_WALK) continue;
      } catch {
        continue;
      }
      ranked.push({
        relativePath,
        score: pathBonus(relativePath),
        symbols: [],
      });
    }

    return this.renderMap(ranked, tokenBudget, true);
  }

  private async walkFiles(
    rootPath: string,
    dirPath: string,
    ig: ReturnType<typeof ignore>,
  ): Promise<string[]> {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      const relativePath = path
        .relative(rootPath, absolutePath)
        .split(path.sep)
        .join('/');
      const candidate = entry.isDirectory() ? `${relativePath}/` : relativePath;

      if (relativePath && ig.ignores(candidate)) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...(await this.walkFiles(rootPath, absolutePath, ig)));
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }

    return files.sort();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private renderMap(
    ranked: RankedFile[],
    tokenBudget: number,
    fallback: boolean,
  ): RepoMapResult {
    // Sort descending by score; stable (same-score files in path order).
    ranked.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

    const filesConsidered = ranked.length;
    const lines: string[] = [];
    let tokensUsed = 0;
    let truncated = false;

    // Header line
    const header = '## Project structure (repo map)\n';
    tokensUsed += estimateTokens(header);
    lines.push(header);

    let filesIncluded = 0;
    for (const file of ranked) {
      if (filesIncluded >= MAX_FILES_IN_MAP) {
        truncated = true;
        break;
      }

      const symbolSuffix =
        file.symbols.length > 0 ? `  — ${file.symbols.join(', ')}` : '';
      const line = `${file.relativePath}${symbolSuffix}\n`;
      const lineCost = estimateTokens(line);

      if (tokensUsed + lineCost > tokenBudget) {
        truncated = true;
        break;
      }

      lines.push(line);
      tokensUsed += lineCost;
      filesIncluded += 1;
    }

    const text = lines.join('');

    return {
      text,
      stats: {
        filesConsidered,
        filesIncluded,
        truncated,
        fallback,
        tokensUsed,
      },
    };
  }
}

// ─── singleton ────────────────────────────────────────────────────────────────

let instance: RepoMapService | null = null;

export function getRepoMapService(): RepoMapService {
  if (!instance) {
    instance = new RepoMapService();
  }
  return instance;
}

export function _resetForTesting(): void {
  instance = null;
}
