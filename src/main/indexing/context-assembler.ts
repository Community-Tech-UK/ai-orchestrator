/**
 * Context Assembler
 *
 * Assembles relevant context for AI queries with token budget management.
 * Combines search results with symbol definitions and imported modules
 * to provide comprehensive context for code understanding.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  AssembledContext,
  ContextChunk,
  SymbolContext,
  ModuleContext,
  HybridSearchOptions,
} from '../../shared/types/codebase.types';
import { HybridSearchService, getHybridSearchService } from './hybrid-search';

// ============================================================================
// Types
// ============================================================================

export interface AssembleContextOptions {
  query: string;
  storeId: string;
  tokenBudget: number;
  includeImports?: boolean;
  includeSymbolDefinitions?: boolean;
  maxChunks?: number;
  minRelevanceScore?: number;
}

interface FileMetadataRow {
  path: string;
  language: string;
  imports_json: string;
  exports_json: string;
  symbols_json: string;
}

interface SymbolRow {
  name: string;
  type: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc_comment: string | null;
}

// ============================================================================
// ContextAssembler Class
// ============================================================================

export class ContextAssembler {
  private db: SqliteDriver;
  private hybridSearch: HybridSearchService;

  constructor(db: SqliteDriver) {
    this.db = db;
    this.hybridSearch = getHybridSearchService(db);
  }

  /**
   * Assemble context for an AI query with token budget management.
   */
  async assembleContext(options: AssembleContextOptions): Promise<AssembledContext> {
    const {
      query,
      storeId,
      tokenBudget,
      includeImports = true,
      includeSymbolDefinitions = true,
      maxChunks = 20,
      minRelevanceScore = 0.3,
    } = options;

    // Allocate token budget
    const mainBudget = Math.floor(tokenBudget * 0.7); // 70% for main content
    const symbolBudget = includeSymbolDefinitions ? Math.floor(tokenBudget * 0.2) : 0; // 20% for symbols
    const importBudget = includeImports ? Math.floor(tokenBudget * 0.1) : 0; // 10% for imports

    // Search for relevant chunks
    const searchOptions: HybridSearchOptions = {
      query,
      storeId,
      topK: maxChunks * 2, // Get extra for filtering
      useHyDE: true,
      minScore: minRelevanceScore,
    };

    const searchResults = await this.hybridSearch.search(searchOptions);

    // Convert to context chunks with token tracking
    const mainChunks: ContextChunk[] = [];
    let currentTokens = 0;

    for (const result of searchResults) {
      const chunkTokens = this.estimateTokens(result.content);

      if (currentTokens + chunkTokens > mainBudget) {
        // Try to fit a truncated version
        const remainingBudget = mainBudget - currentTokens;
        if (remainingBudget > 100) {
          const truncatedContent = this.truncateToTokens(result.content, remainingBudget);
          mainChunks.push({
            content: truncatedContent,
            filePath: result.filePath,
            startLine: result.startLine,
            endLine: result.endLine,
            relevanceScore: result.score,
            language: result.language,
            chunkType: result.chunkType,
          });
        }
        break;
      }

      mainChunks.push({
        content: result.content,
        filePath: result.filePath,
        startLine: result.startLine,
        endLine: result.endLine,
        relevanceScore: result.score,
        language: result.language,
        chunkType: result.chunkType,
      });

      currentTokens += chunkTokens;

      if (mainChunks.length >= maxChunks) {
        break;
      }
    }

    // Find related symbols
    let relatedSymbols: SymbolContext[] = [];
    if (includeSymbolDefinitions && symbolBudget > 0) {
      relatedSymbols = await this.findRelatedSymbols(mainChunks, storeId, symbolBudget);
    }

    // Find imported modules
    let importedModules: ModuleContext[] = [];
    if (includeImports && importBudget > 0) {
      importedModules = await this.findImportedModules(mainChunks, storeId, importBudget);
    }

    // Calculate total tokens
    const totalTokens =
      mainChunks.reduce((sum, c) => sum + this.estimateTokens(c.content), 0) +
      relatedSymbols.reduce((sum, s) => sum + this.estimateTokens(s.definition), 0) +
      importedModules.reduce((sum, m) => sum + this.estimateTokens(m.exports.join(', ')), 0);

    return {
      mainChunks,
      relatedSymbols,
      importedModules,
      totalTokens,
    };
  }

  /**
   * Find symbol definitions referenced in the chunks.
   */
  async findRelatedSymbols(
    chunks: ContextChunk[],
    storeId: string,
    tokenBudget: number
  ): Promise<SymbolContext[]> {
    const symbols: SymbolContext[] = [];
    const seenSymbols = new Set<string>();
    let currentTokens = 0;

    // Extract potential symbol references from chunks
    const symbolNames = this.extractSymbolReferences(chunks);

    for (const symbolName of symbolNames) {
      if (seenSymbols.has(symbolName)) continue;

      const symbolDef = this.lookupSymbolDefinition(symbolName, storeId);
      if (!symbolDef) continue;

      const symbolTokens = this.estimateTokens(symbolDef.definition);
      if (currentTokens + symbolTokens > tokenBudget) {
        break;
      }

      symbols.push(symbolDef);
      seenSymbols.add(symbolName);
      currentTokens += symbolTokens;
    }

    return symbols;
  }

  /**
   * Find module information for imports in the chunks.
   */
  async findImportedModules(
    chunks: ContextChunk[],
    storeId: string,
    tokenBudget: number
  ): Promise<ModuleContext[]> {
    const modules: ModuleContext[] = [];
    const seenModules = new Set<string>();
    let currentTokens = 0;

    // Get unique file paths from chunks
    const filePaths = [...new Set(chunks.map(c => c.filePath))];

    for (const filePath of filePaths) {
      const imports = this.getFileImports(filePath, storeId);

      for (const importPath of imports) {
        if (seenModules.has(importPath)) continue;

        const moduleInfo = this.getModuleInfo(importPath, storeId);
        if (!moduleInfo) continue;

        const moduleTokens = this.estimateTokens(moduleInfo.exports.join(', '));
        if (currentTokens + moduleTokens > tokenBudget) {
          break;
        }

        modules.push(moduleInfo);
        seenModules.add(importPath);
        currentTokens += moduleTokens;
      }
    }

    return modules;
  }

  // ==========================================================================
  // Private: Symbol Lookup
  // ==========================================================================

  private extractSymbolReferences(chunks: ContextChunk[]): string[] {
    const symbols = new Set<string>();

    for (const chunk of chunks) {
      // Extract function calls: functionName(
      const funcCalls = chunk.content.match(/\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*)\s*\(/g);
      if (funcCalls) {
        for (const call of funcCalls) {
          const name = call.replace(/\s*\($/, '');
          if (name.length > 2 && !this.isKeyword(name)) {
            symbols.add(name);
          }
        }
      }

      // Extract type references: : TypeName or <TypeName>
      const typeRefs = chunk.content.match(/[:<]\s*([A-Z][a-zA-Z0-9]*)/g);
      if (typeRefs) {
        for (const ref of typeRefs) {
          const name = ref.replace(/^[:<]\s*/, '');
          if (name.length > 2) {
            symbols.add(name);
          }
        }
      }

      // Extract imports: import { X, Y } from
      const importRefs = chunk.content.match(/import\s*\{([^}]+)\}/g);
      if (importRefs) {
        for (const imp of importRefs) {
          const names = imp.replace(/import\s*\{\s*/, '').replace(/\s*\}$/, '').split(',');
          for (const name of names) {
            const trimmed = name.trim().split(' as ')[0].trim();
            if (trimmed.length > 2) {
              symbols.add(trimmed);
            }
          }
        }
      }
    }

    return Array.from(symbols).slice(0, 50); // Limit to 50 symbols
  }

  private lookupSymbolDefinition(name: string, storeId: string): SymbolContext | null {
    try {
      const stmt = this.db.prepare(`
        SELECT
          s.name,
          s.type,
          cs.file_path,
          cs.start_offset as start_line,
          cs.end_offset as end_line,
          s.signature,
          s.doc_comment
        FROM symbols s
        JOIN context_sections cs ON s.section_id = cs.id
        WHERE s.name = ? AND cs.store_id = ?
        LIMIT 1
      `);

      const row = stmt.get(name, storeId) as SymbolRow | undefined;

      if (!row) return null;

      // Build definition string
      let definition = '';
      if (row.doc_comment) {
        definition += `${row.doc_comment}\n`;
      }
      if (row.signature) {
        definition += row.signature;
      } else {
        definition += `${row.type} ${row.name}`;
      }

      return {
        name: row.name,
        definition,
        filePath: row.file_path,
        line: row.start_line,
        usedBy: [], // Could be populated with reverse references
      };
    } catch {
      return null;
    }
  }

  private isKeyword(name: string): boolean {
    const keywords = new Set([
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
      'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof',
      'instanceof', 'void', 'this', 'super', 'class', 'extends', 'implements',
      'interface', 'enum', 'const', 'let', 'var', 'function', 'async', 'await',
      'import', 'export', 'default', 'from', 'as', 'true', 'false', 'null',
      'undefined', 'number', 'string', 'boolean', 'object', 'any', 'unknown',
      'never', 'void', 'type', 'readonly', 'private', 'public', 'protected',
    ]);
    return keywords.has(name);
  }

  // ==========================================================================
  // Private: Module Info
  // ==========================================================================

  private getFileImports(filePath: string, storeId: string): string[] {
    try {
      const stmt = this.db.prepare(`
        SELECT imports_json
        FROM file_metadata
        WHERE path = ? AND store_id = ?
      `);

      const row = stmt.get(filePath, storeId) as { imports_json: string } | undefined;

      if (!row || !row.imports_json) return [];

      const imports = JSON.parse(row.imports_json) as Array<{ source: string }>;
      return imports.map(i => i.source).filter(s => !s.startsWith('.'));
    } catch {
      return [];
    }
  }

  private getModuleInfo(modulePath: string, storeId: string): ModuleContext | null {
    try {
      // Look for the module in indexed files
      const stmt = this.db.prepare(`
        SELECT path, exports_json
        FROM file_metadata
        WHERE store_id = ? AND (path LIKE ? OR path LIKE ?)
        LIMIT 1
      `);

      const row = stmt.get(
        storeId,
        `%${modulePath}%`,
        `%${modulePath}/index%`
      ) as { path: string; exports_json: string } | undefined;

      if (!row) {
        // Return a basic module context for external modules
        return {
          modulePath,
          exports: [],
          summary: `External module: ${modulePath}`,
        };
      }

      const exports = row.exports_json ? JSON.parse(row.exports_json) : [];
      const exportNames = exports.map((e: { name: string }) => e.name);

      return {
        modulePath: row.path,
        exports: exportNames,
      };
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Private: Token Utilities
  // ==========================================================================

  /**
   * Estimate token count for text (rough approximation).
   */
  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token for code
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate text to approximately fit within token budget.
   */
  private truncateToTokens(text: string, tokenBudget: number): string {
    const charBudget = tokenBudget * 4;
    if (text.length <= charBudget) return text;

    // Try to truncate at a line boundary
    const truncated = text.slice(0, charBudget);
    const lastNewline = truncated.lastIndexOf('\n');

    if (lastNewline > charBudget * 0.7) {
      return truncated.slice(0, lastNewline) + '\n// ... truncated';
    }

    return truncated + '... (truncated)';
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let contextAssemblerInstance: ContextAssembler | null = null;

export function getContextAssembler(db: SqliteDriver): ContextAssembler {
  if (!contextAssemblerInstance) {
    contextAssemblerInstance = new ContextAssembler(db);
  }
  return contextAssemblerInstance;
}

export function resetContextAssembler(): void {
  contextAssemblerInstance = null;
}
