/**
 * Tree-sitter Chunker
 *
 * Language-aware code chunking that extracts meaningful code units
 * (functions, classes, methods) with their signatures and documentation.
 *
 * Currently uses bracket-counting heuristics (from AstChunker) as the
 * parsing backend. The interface is designed to support tree-sitter
 * integration when native module support is added.
 */

import type {
  TreeSitterChunk,
  ChunkConfig,
  ChunkType,
} from '../../shared/types/codebase.types';
import { DEFAULT_CHUNK_CONFIG, getLanguageFromExtension } from './config';
import { getTokenCounter, TokenCounter } from '../rlm/token-counter';

// ============================================================================
// Types
// ============================================================================

interface ParsedNode {
  type: ChunkType;
  name?: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  signature?: string;
  docComment?: string;
  parentType?: string;
  children?: ParsedNode[];
}

// ============================================================================
// Regex Patterns for Each Language
// ============================================================================

const PATTERNS = {
  typescript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)\s*=>\s*(?:\{|[^{])/,
    method: /(?:(?:public|private|protected|static|readonly|async)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/,
    class: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[^{]+)?\s*\{/,
    interface: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{/,
    type: /(?:export\s+)?type\s+(\w+)(?:\s*<[^>]*>)?\s*=/,
    enum: /(?:export\s+)?(?:const\s+)?enum\s+(\w+)\s*\{/,
  },
  javascript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/,
    arrowFunction: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)\s*=>\s*(?:\{|[^{])/,
    method: /(\w+)\s*\([^)]*\)\s*\{/,
    class: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/,
  },
  python: {
    function: /^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[^:]+)?:/m,
    class: /^class\s+(\w+)(?:\s*\([^)]*\))?:/m,
    method: /^\s+(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[^:]+)?:/m,
  },
  rust: {
    function: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\([^)]*\)(?:\s*->\s*[^{]+)?\s*(?:where\s+[^{]+)?\{/,
    struct: /(?:pub\s+)?struct\s+(\w+)(?:<[^>]*>)?(?:\s*\([^)]*\))?(?:\s*where\s+[^{]+)?\s*(?:\{|;)/,
    impl: /impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)(?:<[^>]*>)?(?:\s*where\s+[^{]+)?\s*\{/,
    enum: /(?:pub\s+)?enum\s+(\w+)(?:<[^>]*>)?(?:\s*where\s+[^{]+)?\s*\{/,
    trait: /(?:pub\s+)?trait\s+(\w+)(?:<[^>]*>)?(?:\s*:\s*[^{]+)?\s*\{/,
  },
  go: {
    function: /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\([^)]*\)(?:\s*(?:\([^)]+\)|[^{]+))?\s*\{/,
    struct: /type\s+(\w+)\s+struct\s*\{/,
    interface: /type\s+(\w+)\s+interface\s*\{/,
  },
  java: {
    method: /(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(?:<[^>]*>\s+)?(?:\w+(?:\s*<[^>]*>)?)\s+(\w+)\s*\([^)]*\)(?:\s*throws\s+[^{]+)?\s*\{/,
    class: /(?:(?:public|private|protected|abstract|final)\s+)*class\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+\w+(?:<[^>]*>)?)?(?:\s+implements\s+[^{]+)?\s*\{/,
    interface: /(?:(?:public|private|protected)\s+)?interface\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[^{]+)?\s*\{/,
    enum: /(?:(?:public|private|protected)\s+)?enum\s+(\w+)(?:\s+implements\s+[^{]+)?\s*\{/,
  },
};

// ============================================================================
// TreeSitterChunker Class
// ============================================================================

export class TreeSitterChunker {
  private config: ChunkConfig;
  private tokenCounter: TokenCounter;

  constructor(config: Partial<ChunkConfig> = {}) {
    this.config = { ...DEFAULT_CHUNK_CONFIG, ...config };
    this.tokenCounter = getTokenCounter();
  }

  /**
   * Chunk source code into meaningful units.
   */
  chunk(content: string, language: string, filePath?: string): TreeSitterChunk[] {
    const resolvedLanguage = language || (filePath ? getLanguageFromExtension(filePath) : 'unknown');

    // Parse the content to find code structures
    const nodes = this.parseContent(content, resolvedLanguage);

    // Convert nodes to chunks, respecting token limits
    const chunks = this.nodesToChunks(content, nodes, resolvedLanguage);

    // Merge small adjacent chunks
    return this.mergeSmallChunks(chunks);
  }

  /**
   * Configure the chunker.
   */
  configure(config: Partial<ChunkConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ==========================================================================
  // Private: Parsing
  // ==========================================================================

  private parseContent(content: string, language: string): ParsedNode[] {
    const lines = content.split('\n');
    const nodes: ParsedNode[] = [];

    // Extract imports first
    const importNode = this.extractImports(content, lines, language);
    if (importNode) {
      nodes.push(importNode);
    }

    // Find all declarations
    const patterns = this.getPatternsForLanguage(language);
    if (!patterns) {
      // Unknown language - treat as single block
      return this.createSingleBlockNode(content, lines);
    }

    // Track already-matched regions to avoid duplicates
    const matchedRegions = new Set<string>();

    for (const [patternType, regex] of Object.entries(patterns)) {
      const matches = this.findAllMatches(content, regex as RegExp);

      for (const match of matches) {
        const startLine = this.getLineNumber(content, match.index);
        const regionKey = `${startLine}`;

        if (matchedRegions.has(regionKey)) {
          continue;
        }

        // Find the end of this declaration
        const endLine = this.findDeclarationEnd(lines, startLine, language);
        const startByte = match.index;
        const endByte = this.getByteOffset(content, endLine + 1);

        // Extract signature
        const signature = this.extractSignature(lines, startLine, language);

        // Extract doc comment
        const docComment = this.extractDocComment(content, match.index, language);

        const node: ParsedNode = {
          type: this.mapPatternTypeToChunkType(patternType),
          name: match.name,
          startLine,
          endLine,
          startByte,
          endByte,
          signature,
          docComment,
        };

        nodes.push(node);
        matchedRegions.add(regionKey);
      }
    }

    // Sort by start line
    nodes.sort((a, b) => a.startLine - b.startLine);

    return nodes;
  }

  private extractImports(content: string, lines: string[], language: string): ParsedNode | null {
    const importLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (this.isImportLine(line, language)) {
        importLines.push(i);
      } else if (importLines.length > 0 && line.length > 0 && !line.startsWith('//') && !line.startsWith('#')) {
        // End of import block
        break;
      }
    }

    if (importLines.length === 0) {
      return null;
    }

    const startLine = Math.min(...importLines);
    const endLine = Math.max(...importLines);

    return {
      type: 'import',
      startLine,
      endLine,
      startByte: this.getByteOffset(content, startLine),
      endByte: this.getByteOffset(content, endLine + 1),
    };
  }

  private isImportLine(line: string, language: string): boolean {
    switch (language) {
      case 'typescript':
      case 'javascript':
        return /^import\s|^export\s.*from\s|^require\(|^const\s+\{.*\}\s*=\s*require/.test(line);
      case 'python':
        return /^import\s|^from\s.*import/.test(line);
      case 'rust':
        return /^use\s|^extern\s+crate/.test(line);
      case 'go':
        return /^import\s/.test(line) || /^\s*".*"$/.test(line);
      case 'java':
        return /^import\s/.test(line);
      default:
        return false;
    }
  }

  private findAllMatches(content: string, regex: RegExp): Array<{ index: number; name: string }> {
    const matches: Array<{ index: number; name: string }> = [];
    const globalRegex = new RegExp(regex.source, 'gm');

    let match;
    while ((match = globalRegex.exec(content)) !== null) {
      matches.push({
        index: match.index,
        name: match[1] || 'anonymous',
      });
    }

    return matches;
  }

  private getLineNumber(content: string, byteOffset: number): number {
    const before = content.slice(0, byteOffset);
    return before.split('\n').length - 1;
  }

  private getByteOffset(content: string, lineNumber: number): number {
    const lines = content.split('\n');
    let offset = 0;

    for (let i = 0; i < lineNumber && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }

    return Math.min(offset, content.length);
  }

  private findDeclarationEnd(lines: string[], startLine: number, language: string): number {
    if (language === 'python') {
      return this.findPythonBlockEnd(lines, startLine);
    }

    // Brace-based languages
    return this.findBraceBlockEnd(lines, startLine);
  }

  private findPythonBlockEnd(lines: string[], startLine: number): number {
    const startIndent = this.getIndentLevel(lines[startLine]);
    let endLine = startLine;

    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip blank lines and comments
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }

      const indent = this.getIndentLevel(line);
      if (indent <= startIndent) {
        break;
      }

      endLine = i;
    }

    return endLine;
  }

  private findBraceBlockEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    let foundOpen = false;

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          foundOpen = true;
        } else if (char === '}') {
          braceCount--;

          if (foundOpen && braceCount === 0) {
            return i;
          }
        }
      }
    }

    return lines.length - 1;
  }

  private getIndentLevel(line: string): number {
    const match = line.match(/^(\s*)/);
    if (!match) return 0;

    const spaces = match[1];
    // Convert tabs to 4 spaces
    return spaces.replace(/\t/g, '    ').length;
  }

  private extractSignature(lines: string[], startLine: number, language: string): string {
    let signature = lines[startLine].trim();

    // For multi-line signatures, collect until we hit the body
    for (let i = startLine + 1; i < Math.min(startLine + 5, lines.length); i++) {
      const line = lines[i].trim();

      if (language === 'python' && line.endsWith(':')) {
        signature += ' ' + line;
        break;
      }

      if (line.includes('{') || line.endsWith(':')) {
        const beforeBody = line.split('{')[0].split(':')[0];
        if (beforeBody.trim()) {
          signature += ' ' + beforeBody.trim();
        }
        break;
      }

      signature += ' ' + line;
    }

    return signature.replace(/\s+/g, ' ').trim();
  }

  private extractDocComment(content: string, declarationOffset: number, language: string): string | undefined {
    // Look backwards from the declaration for a doc comment
    const before = content.slice(0, declarationOffset);
    const lines = before.split('\n');

    // Check last few lines for doc comments
    const relevantLines = lines.slice(-10).join('\n');

    if (['typescript', 'javascript', 'java'].includes(language)) {
      const jsdocMatch = relevantLines.match(/\/\*\*[\s\S]*?\*\/\s*$/);
      if (jsdocMatch) {
        return jsdocMatch[0].trim();
      }
    }

    if (language === 'python') {
      // Python docstrings are inside the function, handled differently
      return undefined;
    }

    if (language === 'rust') {
      const rustDocLines: string[] = [];
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
        const line = lines[i].trim();
        if (line.startsWith('///') || line.startsWith('//!')) {
          rustDocLines.unshift(line);
        } else if (line.length > 0 && !rustDocLines.length) {
          break;
        } else if (rustDocLines.length && line.length > 0 && !line.startsWith('///')) {
          break;
        }
      }
      if (rustDocLines.length > 0) {
        return rustDocLines.join('\n');
      }
    }

    return undefined;
  }

  private getPatternsForLanguage(language: string): Record<string, RegExp> | null {
    return PATTERNS[language as keyof typeof PATTERNS] || null;
  }

  private mapPatternTypeToChunkType(patternType: string): ChunkType {
    const mapping: Record<string, ChunkType> = {
      function: 'function',
      arrowFunction: 'function',
      method: 'method',
      class: 'class',
      interface: 'interface',
      type: 'type',
      enum: 'type',
      struct: 'class',
      impl: 'class',
      trait: 'interface',
    };

    return mapping[patternType] || 'block';
  }

  private createSingleBlockNode(content: string, lines: string[]): ParsedNode[] {
    return [{
      type: 'block',
      startLine: 0,
      endLine: lines.length - 1,
      startByte: 0,
      endByte: content.length,
    }];
  }

  // ==========================================================================
  // Private: Chunk Creation
  // ==========================================================================

  private nodesToChunks(content: string, nodes: ParsedNode[], language: string): TreeSitterChunk[] {
    const lines = content.split('\n');
    const chunks: TreeSitterChunk[] = [];

    // Find imports for prepending
    const importNode = nodes.find(n => n.type === 'import');
    const importContent = importNode
      ? lines.slice(importNode.startLine, importNode.endLine + 1).join('\n')
      : '';

    // Process each node
    for (const node of nodes) {
      if (node.type === 'import') {
        // Create separate import chunk
        const chunkContent = lines.slice(node.startLine, node.endLine + 1).join('\n');
        const tokens = this.tokenCounter.countTokens(chunkContent);

        if (tokens >= this.config.minTokens) {
          chunks.push(this.createChunk(chunkContent, node, language));
        }
        continue;
      }

      const nodeContent = lines.slice(node.startLine, node.endLine + 1).join('\n');
      const tokens = this.tokenCounter.countTokens(nodeContent);

      if (tokens > this.config.maxTokens) {
        // Split large nodes
        const splitChunks = this.splitLargeNode(lines, node, language, importContent);
        chunks.push(...splitChunks);
      } else {
        chunks.push(this.createChunk(nodeContent, node, language));
      }
    }

    // Handle gaps between nodes (orphan code)
    const filledChunks = this.fillGaps(content, lines, chunks, nodes, language);

    return filledChunks;
  }

  private createChunk(
    content: string,
    node: ParsedNode,
    language: string
  ): TreeSitterChunk {
    return {
      content,
      type: node.type,
      name: node.name,
      language,
      startByte: node.startByte,
      endByte: node.endByte,
      startLine: node.startLine,
      endLine: node.endLine,
      tokens: this.tokenCounter.countTokens(content),
      nodeType: node.type,
      parentType: node.parentType,
      signature: node.signature,
      docComment: node.docComment,
    };
  }

  private splitLargeNode(
    lines: string[],
    node: ParsedNode,
    language: string,
    importContent: string
  ): TreeSitterChunk[] {
    const chunks: TreeSitterChunk[] = [];
    const nodeLines = lines.slice(node.startLine, node.endLine + 1);
    let currentLines: string[] = [];
    let currentTokens = 0;
    let partIndex = 0;

    const importTokens = this.tokenCounter.countTokens(importContent);
    const availableTokens = this.config.maxTokens - importTokens - 50; // Reserve some space

    for (let i = 0; i < nodeLines.length; i++) {
      const line = nodeLines[i];
      const lineTokens = this.tokenCounter.countTokens(line);

      if (currentTokens + lineTokens > availableTokens && currentLines.length > 0) {
        // Create chunk with import context
        let chunkContent = currentLines.join('\n');
        if (importContent && partIndex > 0) {
          chunkContent = importContent + '\n\n// (continued)\n' + chunkContent;
        }

        chunks.push({
          content: chunkContent,
          type: node.type,
          name: node.name ? `${node.name} (part ${partIndex + 1})` : undefined,
          language,
          startByte: node.startByte,
          endByte: node.endByte,
          startLine: node.startLine + (partIndex > 0 ? Math.floor(i / 2) : 0),
          endLine: node.startLine + i - 1,
          tokens: this.tokenCounter.countTokens(chunkContent),
          nodeType: node.type,
          parentType: node.parentType,
          signature: partIndex === 0 ? node.signature : undefined,
          docComment: partIndex === 0 ? node.docComment : undefined,
        });

        currentLines = [];
        currentTokens = 0;
        partIndex++;
      }

      currentLines.push(line);
      currentTokens += lineTokens;
    }

    // Final chunk
    if (currentLines.length > 0) {
      let chunkContent = currentLines.join('\n');
      if (importContent && partIndex > 0) {
        chunkContent = importContent + '\n\n// (continued)\n' + chunkContent;
      }

      chunks.push({
        content: chunkContent,
        type: node.type,
        name: node.name ? `${node.name} (part ${partIndex + 1})` : undefined,
        language,
        startByte: node.startByte,
        endByte: node.endByte,
        startLine: node.startLine + Math.floor(nodeLines.length * partIndex / (partIndex + 1)),
        endLine: node.endLine,
        tokens: this.tokenCounter.countTokens(chunkContent),
        nodeType: node.type,
        parentType: node.parentType,
      });
    }

    return chunks;
  }

  private fillGaps(
    content: string,
    lines: string[],
    chunks: TreeSitterChunk[],
    nodes: ParsedNode[],
    language: string
  ): TreeSitterChunk[] {
    if (nodes.length === 0) {
      // No nodes found - create single chunk
      return [{
        content,
        type: 'block',
        language,
        startByte: 0,
        endByte: content.length,
        startLine: 0,
        endLine: lines.length - 1,
        tokens: this.tokenCounter.countTokens(content),
        nodeType: 'block',
      }];
    }

    const result: TreeSitterChunk[] = [];
    let lastEndLine = -1;

    // Sort nodes by start line
    const sortedNodes = [...nodes].sort((a, b) => a.startLine - b.startLine);

    for (let i = 0; i < sortedNodes.length; i++) {
      const node = sortedNodes[i];

      // Check for gap before this node
      if (node.startLine > lastEndLine + 1) {
        const gapContent = lines.slice(lastEndLine + 1, node.startLine).join('\n').trim();
        const gapTokens = this.tokenCounter.countTokens(gapContent);

        if (gapTokens >= this.config.minTokens) {
          result.push({
            content: gapContent,
            type: 'block',
            language,
            startByte: this.getByteOffset(content, lastEndLine + 1),
            endByte: this.getByteOffset(content, node.startLine),
            startLine: lastEndLine + 1,
            endLine: node.startLine - 1,
            tokens: gapTokens,
            nodeType: 'block',
          });
        }
      }

      // Find corresponding chunk for this node
      const nodeChunks = chunks.filter(
        c => c.startLine >= node.startLine && c.endLine <= node.endLine
      );
      result.push(...nodeChunks);

      lastEndLine = Math.max(lastEndLine, node.endLine);
    }

    // Check for trailing content
    if (lastEndLine < lines.length - 1) {
      const gapContent = lines.slice(lastEndLine + 1).join('\n').trim();
      const gapTokens = this.tokenCounter.countTokens(gapContent);

      if (gapTokens >= this.config.minTokens) {
        result.push({
          content: gapContent,
          type: 'block',
          language,
          startByte: this.getByteOffset(content, lastEndLine + 1),
          endByte: content.length,
          startLine: lastEndLine + 1,
          endLine: lines.length - 1,
          tokens: gapTokens,
          nodeType: 'block',
        });
      }
    }

    return result.length > 0 ? result : chunks;
  }

  private mergeSmallChunks(chunks: TreeSitterChunk[]): TreeSitterChunk[] {
    if (chunks.length <= 1) {
      return chunks;
    }

    const merged: TreeSitterChunk[] = [];
    let current: TreeSitterChunk | null = null;

    for (const chunk of chunks) {
      if (!current) {
        current = { ...chunk };
        continue;
      }

      // Check if we can merge
      const combinedTokens: number = current.tokens + chunk.tokens;

      if (combinedTokens <= this.config.maxTokens) {
        // Small adjacent chunks can be merged
        if (current.tokens < this.config.minTokens || chunk.tokens < this.config.minTokens) {
          current = {
            ...current,
            content: current.content + '\n\n' + chunk.content,
            endLine: chunk.endLine,
            endByte: chunk.endByte,
            tokens: combinedTokens,
            type: current.type === chunk.type ? current.type : 'block',
            name: current.name || chunk.name,
          };
          continue;
        }
      }

      // Can't merge - push current and start new
      merged.push(current);
      current = { ...chunk };
    }

    if (current) {
      merged.push(current);
    }

    return merged;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let treeSitterChunkerInstance: TreeSitterChunker | null = null;

export function getTreeSitterChunker(config?: Partial<ChunkConfig>): TreeSitterChunker {
  if (!treeSitterChunkerInstance) {
    treeSitterChunkerInstance = new TreeSitterChunker(config);
  }
  return treeSitterChunkerInstance;
}

export function resetTreeSitterChunker(): void {
  treeSitterChunkerInstance = null;
}
