/**
 * Semantic Code Search - Search code by meaning (4.7)
 *
 * Provides semantic code search beyond simple text matching.
 * Supports integration with external APIs like Exa for enhanced search.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { getLogger } from '../logging/logger';

const logger = getLogger('SemanticSearch');

/**
 * Search result item
 */
export interface SemanticSearchResult {
  file: string;
  relativePath: string;
  score: number;
  snippet: string;
  lineNumber: number;
  context: string;
  matchType: 'semantic' | 'keyword' | 'symbol';
}

/**
 * Search options
 */
export interface SemanticSearchOptions {
  query: string;
  directory: string;
  maxResults?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  searchType?: 'semantic' | 'hybrid' | 'keyword';
  minScore?: number;
}

/**
 * Exa API configuration
 */
export interface ExaConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Code symbol for indexing
 */
export interface CodeSymbol {
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'constant';
  file: string;
  line: number;
  documentation?: string;
  signature?: string;
}

/**
 * Simple in-memory index for local semantic search
 */
interface SearchIndex {
  symbols: CodeSymbol[];
  fileContents: Map<string, string>;
  lastIndexed: number;
}

/**
 * Semantic Search Manager
 */
export class SemanticSearchManager {
  private exaConfig: ExaConfig | null = null;
  private index: SearchIndex = {
    symbols: [],
    fileContents: new Map(),
    lastIndexed: 0,
  };
  private indexing: boolean = false;

  /**
   * Configure Exa API for external semantic search
   */
  configureExa(config: ExaConfig): void {
    this.exaConfig = config;
  }

  /**
   * Check if Exa is configured
   */
  isExaConfigured(): boolean {
    return this.exaConfig !== null && !!this.exaConfig.apiKey;
  }

  /**
   * Search using Exa API (if configured) or fallback to local search
   */
  async search(options: SemanticSearchOptions): Promise<SemanticSearchResult[]> {
    const { query, directory, maxResults = 20, searchType = 'hybrid' } = options;

    // Try Exa first if configured and semantic search is requested
    if (this.isExaConfigured() && searchType !== 'keyword') {
      try {
        const exaResults = await this.searchWithExa(query, directory, maxResults);
        if (exaResults.length > 0) {
          return exaResults;
        }
      } catch (error) {
        logger.warn('Exa search failed, falling back to local search', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Fall back to local search
    return this.localSearch(options);
  }

  /**
   * Search using Exa API
   */
  private async searchWithExa(
    query: string,
    directory: string,
    maxResults: number
  ): Promise<SemanticSearchResult[]> {
    if (!this.exaConfig) {
      throw new Error('Exa not configured');
    }

    // Note: This is a placeholder for actual Exa API integration
    // The real implementation would call the Exa API with the code search endpoint
    return new Promise((resolve, reject) => {
      const url = new URL(this.exaConfig!.baseUrl || 'https://api.exa.ai/search');

      const postData = JSON.stringify({
        query: `code: ${query}`,
        numResults: maxResults,
        type: 'auto',
        useAutoprompt: true,
      });

      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.exaConfig!.apiKey,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            // Transform Exa response to our format
            const results: SemanticSearchResult[] = (response.results || []).map((r: any) => ({
              file: r.url || '',
              relativePath: r.url || '',
              score: r.score || 0.5,
              snippet: r.text || '',
              lineNumber: 1,
              context: r.title || '',
              matchType: 'semantic' as const,
            }));
            resolve(results);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Local semantic-ish search (keyword + symbol matching)
   */
  async localSearch(options: SemanticSearchOptions): Promise<SemanticSearchResult[]> {
    const {
      query,
      directory,
      maxResults = 20,
      includePatterns = ['**/*.ts', '**/*.js', '**/*.py', '**/*.go', '**/*.rs', '**/*.java'],
      excludePatterns = ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      minScore = 0.3,
    } = options;

    // Ensure index is up to date
    await this.buildIndex(directory, includePatterns, excludePatterns);

    const results: SemanticSearchResult[] = [];
    const queryTerms = this.tokenize(query.toLowerCase());

    // Search symbols
    for (const symbol of this.index.symbols) {
      const score = this.calculateSymbolScore(symbol, queryTerms);
      if (score >= minScore) {
        results.push({
          file: symbol.file,
          relativePath: path.relative(directory, symbol.file),
          score,
          snippet: symbol.signature || symbol.name,
          lineNumber: symbol.line,
          context: symbol.documentation || `${symbol.type}: ${symbol.name}`,
          matchType: 'symbol',
        });
      }
    }

    // Search file contents for keyword matches
    for (const [filePath, content] of this.index.fileContents) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const score = this.calculateLineScore(line, queryTerms);
        if (score >= minScore) {
          // Check if we already have a symbol match for this line
          const existingSymbol = results.find(
            (r) => r.file === filePath && Math.abs(r.lineNumber - (i + 1)) < 3
          );
          if (!existingSymbol) {
            results.push({
              file: filePath,
              relativePath: path.relative(directory, filePath),
              score,
              snippet: line.trim(),
              lineNumber: i + 1,
              context: this.getContext(lines, i),
              matchType: 'keyword',
            });
          }
        }
      }
    }

    // Sort by score and limit results
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Build search index for a directory
   */
  async buildIndex(
    directory: string,
    includePatterns: string[],
    excludePatterns: string[]
  ): Promise<void> {
    if (this.indexing) return;

    // Check if index is recent (less than 5 minutes old)
    const now = Date.now();
    if (now - this.index.lastIndexed < 5 * 60 * 1000 && this.index.symbols.length > 0) {
      return;
    }

    this.indexing = true;
    this.index.symbols = [];
    this.index.fileContents.clear();

    try {
      await this.indexDirectory(directory, includePatterns, excludePatterns);
      this.index.lastIndexed = now;
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Index a directory recursively
   */
  private async indexDirectory(
    directory: string,
    includePatterns: string[],
    excludePatterns: string[]
  ): Promise<void> {
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(directory, fullPath);

      // Check exclude patterns
      if (this.matchesPatterns(relativePath, excludePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.indexDirectory(fullPath, includePatterns, excludePatterns);
      } else if (entry.isFile()) {
        // Check include patterns
        if (this.matchesPatterns(relativePath, includePatterns)) {
          await this.indexFile(fullPath);
        }
      }
    }
  }

  /**
   * Check if path matches any patterns
   */
  private matchesPatterns(filePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      // Simple glob matching
      const regex = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\./g, '\\.');
      if (new RegExp(`^${regex}$`).test(filePath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.index.fileContents.set(filePath, content);

      // Extract symbols based on file extension
      const ext = path.extname(filePath).toLowerCase();
      const symbols = this.extractSymbols(content, filePath, ext);
      this.index.symbols.push(...symbols);
    } catch (error) {
      // Skip files that can't be read
    }
  }

  /**
   * Extract code symbols from content
   */
  private extractSymbols(content: string, filePath: string, ext: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    // Language-specific patterns
    const patterns: Record<string, RegExp[]> = {
      '.ts': [
        /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        /^(?:export\s+)?class\s+(\w+)/,
        /^(?:export\s+)?interface\s+(\w+)/,
        /^(?:export\s+)?type\s+(\w+)/,
        /^(?:export\s+)?const\s+(\w+)\s*=/,
        /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\(/,
      ],
      '.js': [
        /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        /^(?:export\s+)?class\s+(\w+)/,
        /^(?:export\s+)?const\s+(\w+)\s*=/,
      ],
      '.py': [
        /^def\s+(\w+)/,
        /^class\s+(\w+)/,
        /^(\w+)\s*=\s*(?:lambda|def)/,
      ],
      '.go': [
        /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
        /^type\s+(\w+)\s+(?:struct|interface)/,
      ],
      '.rs': [
        /^(?:pub\s+)?fn\s+(\w+)/,
        /^(?:pub\s+)?struct\s+(\w+)/,
        /^(?:pub\s+)?trait\s+(\w+)/,
        /^(?:pub\s+)?enum\s+(\w+)/,
      ],
      '.java': [
        /^(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+(\w+)/,
        /^(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?interface\s+(\w+)/,
        /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:\w+)\s+(\w+)\s*\(/,
      ],
    };

    const languagePatterns = patterns[ext] || patterns['.ts'];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of languagePatterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          const symbolType = this.inferSymbolType(line);
          symbols.push({
            name: match[1],
            type: symbolType,
            file: filePath,
            line: i + 1,
            signature: line.trim(),
            documentation: this.extractDocComment(lines, i),
          });
        }
      }
    }

    return symbols;
  }

  /**
   * Infer symbol type from line content
   */
  private inferSymbolType(line: string): CodeSymbol['type'] {
    const lower = line.toLowerCase();
    if (lower.includes('class')) return 'class';
    if (lower.includes('interface')) return 'interface';
    if (lower.includes('type')) return 'type';
    if (lower.includes('const') || lower.includes('let') || lower.includes('var')) return 'constant';
    if (lower.includes('function') || lower.includes('fn') || lower.includes('def')) return 'function';
    return 'method';
  }

  /**
   * Extract documentation comment above a line
   */
  private extractDocComment(lines: string[], lineIndex: number): string | undefined {
    const comments: string[] = [];
    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('*') || line.startsWith('//') || line.startsWith('#')) {
        comments.unshift(line.replace(/^[\/*#\s]+/, ''));
      } else if (line === '/**' || line === '/*') {
        break;
      } else if (line !== '') {
        break;
      }
    }
    return comments.length > 0 ? comments.join(' ') : undefined;
  }

  /**
   * Tokenize query into terms
   */
  private tokenize(text: string): string[] {
    return text
      .split(/[\s_\-./]+/)
      .filter((t) => t.length > 1)
      .map((t) => t.toLowerCase());
  }

  /**
   * Calculate relevance score for a symbol
   */
  private calculateSymbolScore(symbol: CodeSymbol, queryTerms: string[]): number {
    let score = 0;
    const symbolTerms = this.tokenize(symbol.name);
    const docTerms = symbol.documentation ? this.tokenize(symbol.documentation) : [];

    for (const term of queryTerms) {
      // Exact match in name
      if (symbol.name.toLowerCase() === term) {
        score += 1.0;
      }
      // Partial match in name
      else if (symbol.name.toLowerCase().includes(term)) {
        score += 0.7;
      }
      // Term in tokenized name
      else if (symbolTerms.includes(term)) {
        score += 0.5;
      }
      // Match in documentation
      else if (docTerms.includes(term)) {
        score += 0.3;
      }
    }

    // Normalize by query length
    return Math.min(1.0, score / queryTerms.length);
  }

  /**
   * Calculate relevance score for a line
   */
  private calculateLineScore(line: string, queryTerms: string[]): number {
    let score = 0;
    const lineLower = line.toLowerCase();
    const lineTerms = this.tokenize(lineLower);

    for (const term of queryTerms) {
      if (lineLower.includes(term)) {
        score += 0.5;
      } else if (lineTerms.includes(term)) {
        score += 0.3;
      }
    }

    return Math.min(1.0, score / queryTerms.length);
  }

  /**
   * Get context lines around a match
   */
  private getContext(lines: string[], lineIndex: number, contextSize: number = 2): string {
    const start = Math.max(0, lineIndex - contextSize);
    const end = Math.min(lines.length, lineIndex + contextSize + 1);
    return lines.slice(start, end).join('\n');
  }

  /**
   * Clear the search index
   */
  clearIndex(): void {
    this.index.symbols = [];
    this.index.fileContents.clear();
    this.index.lastIndexed = 0;
  }

  /**
   * Get index statistics
   */
  getIndexStats(): { files: number; symbols: number; lastIndexed: number } {
    return {
      files: this.index.fileContents.size,
      symbols: this.index.symbols.length,
      lastIndexed: this.index.lastIndexed,
    };
  }
}

// Singleton instance
let semanticSearchInstance: SemanticSearchManager | null = null;

export function getSemanticSearchManager(): SemanticSearchManager {
  if (!semanticSearchInstance) {
    semanticSearchInstance = new SemanticSearchManager();
  }
  return semanticSearchInstance;
}
