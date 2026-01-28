/**
 * File Metadata Extractor
 *
 * Extracts imports, exports, symbols, and dependencies from source files.
 * Provides rich metadata for context assembly and symbol navigation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  FileMetadata,
  ImportInfo,
  ExportInfo,
  SymbolInfo,
  FrameworkType,
} from '../../shared/types/codebase.types';
import { getLanguageFromExtension } from './config';

// ============================================================================
// Regex Patterns for Extraction
// ============================================================================

const IMPORT_PATTERNS = {
  typescript: [
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
  ],
  javascript: [
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['"]([^'"]+)['"]\)/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/g,
  ],
  python: [
    /from\s+([\w.]+)\s+import\s+([^#\n]+)/g,
    /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm,
  ],
  rust: [
    /use\s+([\w:]+)(?:::\{([^}]+)\})?(?:\s+as\s+(\w+))?;/g,
  ],
  go: [
    /import\s+(?:(\w+)\s+)?["']([^"']+)["']/g,
    /import\s+\(\s*((?:[^)]+))\s*\)/gs,
  ],
  java: [
    /import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;/g,
  ],
};

const EXPORT_PATTERNS = {
  typescript: [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:abstract\s+)?class\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+(?:const\s+)?enum\s+(\w+)/g,
    /export\s+default\s+(?:class|function)?\s*(\w+)?/g,
    /export\s+\{([^}]+)\}/g,
  ],
  javascript: [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+default\s+(?:class|function)?\s*(\w+)?/g,
    /export\s+\{([^}]+)\}/g,
    /module\.exports\s*=\s*(\w+|\{[^}]+\})/g,
  ],
  python: [
    /__all__\s*=\s*\[([^\]]+)\]/g,
  ],
  rust: [
    /pub\s+(?:async\s+)?fn\s+(\w+)/g,
    /pub\s+struct\s+(\w+)/g,
    /pub\s+enum\s+(\w+)/g,
    /pub\s+trait\s+(\w+)/g,
    /pub\s+type\s+(\w+)/g,
    /pub\s+mod\s+(\w+)/g,
  ],
  go: [
    /func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)/g,
    /type\s+([A-Z]\w*)\s+(?:struct|interface)/g,
    /const\s+([A-Z]\w*)/g,
    /var\s+([A-Z]\w*)/g,
  ],
  java: [
    /public\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/g,
  ],
};

const SYMBOL_PATTERNS = {
  typescript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g,
    class: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/g,
    interface: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{/g,
    type: /(?:export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/g,
    const: /(?:export\s+)?const\s+(\w+)(?:\s*:\s*([^=]+))?\s*=/g,
    method: /(?:(?:public|private|protected|static|readonly|async)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g,
  },
  javascript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
    class: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g,
    const: /(?:export\s+)?const\s+(\w+)\s*=/g,
    method: /(\w+)\s*\(([^)]*)\)\s*\{/g,
  },
  python: {
    function: /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/gm,
    class: /^class\s+(\w+)(?:\s*\(([^)]*)\))?:/gm,
  },
  rust: {
    function: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?\s*(?:where\s+[^{]+)?\{/g,
    struct: /(?:pub\s+)?struct\s+(\w+)(?:<[^>]*>)?/g,
    enum: /(?:pub\s+)?enum\s+(\w+)(?:<[^>]*>)?/g,
    trait: /(?:pub\s+)?trait\s+(\w+)(?:<[^>]*>)?/g,
    impl: /impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?(\w+)/g,
  },
  go: {
    function: /func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]+)\)|([^{]+)))?\s*\{/g,
    struct: /type\s+(\w+)\s+struct\s*\{/g,
    interface: /type\s+(\w+)\s+interface\s*\{/g,
  },
  java: {
    method: /(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(?:<[^>]*>\s+)?(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(([^)]*)\)/g,
    class: /(?:(?:public|private|protected|abstract|final)\s+)*class\s+(\w+)(?:<[^>]*>)?/g,
    interface: /(?:(?:public|private|protected)\s+)?interface\s+(\w+)(?:<[^>]*>)?/g,
  },
};

const FRAMEWORK_PATTERNS: Array<{ pattern: RegExp; framework: FrameworkType }> = [
  { pattern: /@angular\/core|@Component|@Injectable|@NgModule/, framework: 'angular' },
  { pattern: /from\s+['"]react['"]|import\s+React|jsx|tsx/, framework: 'react' },
  { pattern: /from\s+['"]vue['"]|\.vue$|createApp|defineComponent/, framework: 'vue' },
  { pattern: /from\s+['"]svelte['"]|\.svelte$/, framework: 'svelte' },
  { pattern: /from\s+['"]express['"]|express\(\)/, framework: 'express' },
  { pattern: /from\s+fastapi|FastAPI/, framework: 'fastapi' },
  { pattern: /@nestjs\/|@Module|@Controller|@Injectable/, framework: 'nestjs' },
  { pattern: /from\s+django|Django/, framework: 'django' },
];

// ============================================================================
// MetadataExtractor Class
// ============================================================================

export class MetadataExtractor {
  async extractFileMetadata(filePath: string, content?: string): Promise<FileMetadata> {
    const absolutePath = path.resolve(filePath);
    const fileContent = content ?? await fs.promises.readFile(absolutePath, 'utf-8');
    const stats = await fs.promises.stat(absolutePath);
    const language = getLanguageFromExtension(filePath);

    const lines = fileContent.split('\n');
    const hash = crypto.createHash('md5').update(fileContent).digest('hex');

    const imports = this.extractImports(fileContent, language);
    const exports = this.extractExports(fileContent, language);
    const symbols = this.extractSymbols(fileContent, language);
    const framework = this.detectFramework(fileContent, filePath);

    return {
      path: absolutePath,
      relativePath: filePath,
      language,
      size: stats.size,
      lines: lines.length,
      hash,
      lastModified: stats.mtimeMs,
      imports,
      exports,
      symbols,
      framework,
      isEntryPoint: this.isEntryPoint(filePath, exports),
      isTestFile: this.isTestFile(filePath),
      isConfigFile: this.isConfigFile(filePath),
    };
  }

  async extractDirectoryMetadata(
    dirPath: string,
    options: { patterns?: string[]; maxFiles?: number } = {}
  ): Promise<FileMetadata[]> {
    const glob = await import('glob');
    const patterns = options.patterns || ['**/*.{ts,tsx,js,jsx,py,rs,go,java}'];
    const maxFiles = options.maxFiles || 10000;

    const files: string[] = [];
    for (const pattern of patterns) {
      const matches = await glob.glob(pattern, {
        cwd: dirPath,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        absolute: true,
      });
      files.push(...matches);
      if (files.length >= maxFiles) break;
    }

    const uniqueFiles = [...new Set(files)].slice(0, maxFiles);
    const metadata: FileMetadata[] = [];

    const batchSize = 50;
    for (let i = 0; i < uniqueFiles.length; i += batchSize) {
      const batch = uniqueFiles.slice(i, i + batchSize);
      const batchMetadata = await Promise.all(
        batch.map(async (file) => {
          try {
            return await this.extractFileMetadata(file);
          } catch (error) {
            console.warn(`Failed to extract metadata from ${file}:`, error);
            return null;
          }
        })
      );
      metadata.push(...batchMetadata.filter((m): m is FileMetadata => m !== null));
    }

    return metadata;
  }

  private extractImports(content: string, language: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const patterns = IMPORT_PATTERNS[language as keyof typeof IMPORT_PATTERNS];

    if (!patterns) return imports;

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;

      while ((match = regex.exec(content)) !== null) {
        const lineNumber = this.getLineNumber(content, match.index);
        const importInfo = this.parseImportMatch(match, language, lineNumber);
        if (importInfo) imports.push(importInfo);
      }
    }

    return imports;
  }

  private parseImportMatch(match: RegExpExecArray, language: string, line: number): ImportInfo | null {
    const fullMatch = match[0];

    switch (language) {
      case 'typescript':
      case 'javascript': {
        const isTypeOnly = fullMatch.includes('import type');
        const isDefault = !fullMatch.includes('{') && /import\s+\w+\s+from/.test(fullMatch);

        const sourceMatch = fullMatch.match(/from\s+['"]([^'"]+)['"]/);
        const requireMatch = fullMatch.match(/require\(['"]([^'"]+)['"]\)/);
        const source = sourceMatch?.[1] || requireMatch?.[1] || match[1];

        if (!source) return null;

        let specifiers: string[] = [];
        if (fullMatch.includes('{')) {
          const specMatch = fullMatch.match(/\{([^}]+)\}/);
          if (specMatch) {
            specifiers = specMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
          }
        } else if (fullMatch.includes('* as')) {
          const nsMatch = fullMatch.match(/\*\s+as\s+(\w+)/);
          if (nsMatch) specifiers = [nsMatch[1]];
        } else if (isDefault) {
          const defaultMatch = fullMatch.match(/import\s+(\w+)\s+from/);
          if (defaultMatch) specifiers = [defaultMatch[1]];
        }

        return { source, specifiers, isTypeOnly, isDefault, line };
      }

      case 'python': {
        if (fullMatch.startsWith('from')) {
          const source = match[1];
          const specifiersStr = match[2];
          const specifiers = specifiersStr
            .split(',')
            .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
            .filter((s) => s && !s.startsWith('#'));

          return { source, specifiers, isTypeOnly: false, isDefault: false, line };
        } else {
          const source = match[1];
          return { source, specifiers: [match[2] || source.split('.').pop()!], isTypeOnly: false, isDefault: true, line };
        }
      }

      case 'rust': {
        const source = match[1];
        let specifiers: string[] = [];

        if (match[2]) {
          specifiers = match[2].split(',').map((s) => s.trim());
        } else {
          specifiers = [source.split('::').pop()!];
        }

        return { source, specifiers, isTypeOnly: false, isDefault: false, line };
      }

      case 'go': {
        if (match[2]) {
          return {
            source: match[2],
            specifiers: [match[1] || path.basename(match[2])],
            isTypeOnly: false,
            isDefault: !!match[1],
            line,
          };
        }
        return null;
      }

      case 'java': {
        const source = match[1];
        const parts = source.split('.');
        const specifier = parts[parts.length - 1];

        return {
          source,
          specifiers: specifier === '*' ? [] : [specifier],
          isTypeOnly: false,
          isDefault: false,
          line,
        };
      }

      default:
        return null;
    }
  }

  private extractExports(content: string, language: string): ExportInfo[] {
    const exports: ExportInfo[] = [];
    const patterns = EXPORT_PATTERNS[language as keyof typeof EXPORT_PATTERNS];

    if (!patterns) return exports;

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;

      while ((match = regex.exec(content)) !== null) {
        const lineNumber = this.getLineNumber(content, match.index);
        const exportInfo = this.parseExportMatch(match, language, lineNumber);
        if (exportInfo) {
          if (Array.isArray(exportInfo)) {
            exports.push(...exportInfo);
          } else {
            exports.push(exportInfo);
          }
        }
      }
    }

    return exports;
  }

  private parseExportMatch(match: RegExpExecArray, language: string, line: number): ExportInfo | ExportInfo[] | null {
    const fullMatch = match[0];

    switch (language) {
      case 'typescript':
      case 'javascript': {
        const isDefault = fullMatch.includes('export default');

        if (fullMatch.includes('export {')) {
          const specMatch = fullMatch.match(/\{([^}]+)\}/);
          if (specMatch) {
            return specMatch[1].split(',').map((s) => ({
              name: s.trim().split(/\s+as\s+/)[0].trim(),
              type: 'variable' as const,
              line,
              isDefault: false,
            }));
          }
        }

        if (fullMatch.includes('function')) {
          return { name: match[1] || 'default', type: 'function', line, isDefault };
        }
        if (fullMatch.includes('class')) {
          return { name: match[1] || 'default', type: 'class', line, isDefault };
        }
        if (fullMatch.includes('interface')) {
          return { name: match[1], type: 'interface', line, isDefault: false };
        }
        if (fullMatch.includes('type ')) {
          return { name: match[1], type: 'type', line, isDefault: false };
        }
        if (fullMatch.includes('enum')) {
          return { name: match[1], type: 'type', line, isDefault: false };
        }
        if (fullMatch.includes('const') || fullMatch.includes('let') || fullMatch.includes('var')) {
          return { name: match[1], type: 'variable', line, isDefault: false };
        }
        if (isDefault && match[1]) {
          return { name: match[1], type: 'default', line, isDefault: true };
        }

        return null;
      }

      case 'python': {
        const items = match[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
        return items.map((name) => ({
          name,
          type: 'variable' as const,
          line,
          isDefault: false,
        }));
      }

      case 'rust': {
        if (fullMatch.includes('fn')) return { name: match[1], type: 'function', line, isDefault: false };
        if (fullMatch.includes('struct')) return { name: match[1], type: 'class', line, isDefault: false };
        if (fullMatch.includes('enum')) return { name: match[1], type: 'type', line, isDefault: false };
        if (fullMatch.includes('trait')) return { name: match[1], type: 'interface', line, isDefault: false };
        if (fullMatch.includes('type')) return { name: match[1], type: 'type', line, isDefault: false };
        if (fullMatch.includes('mod')) return { name: match[1], type: 'namespace', line, isDefault: false };
        return null;
      }

      case 'go':
        return { name: match[1] || match[3], type: 'function', line, isDefault: false };

      case 'java':
        return { name: match[1], type: 'class', line, isDefault: false };

      default:
        return null;
    }
  }

  private extractSymbols(content: string, language: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const patterns = SYMBOL_PATTERNS[language as keyof typeof SYMBOL_PATTERNS];

    if (!patterns) return symbols;

    for (const [symbolType, pattern] of Object.entries(patterns)) {
      const regex = new RegExp((pattern as RegExp).source, (pattern as RegExp).flags);
      let match;

      while ((match = regex.exec(content)) !== null) {
        const lineNumber = this.getLineNumber(content, match.index);
        const column = this.getColumnNumber(content, match.index);
        const symbolInfo = this.parseSymbolMatch(match, symbolType, language, lineNumber, column);

        if (symbolInfo) symbols.push(symbolInfo);
      }
    }

    return symbols;
  }

  private parseSymbolMatch(match: RegExpExecArray, symbolType: string, language: string, line: number, column: number): SymbolInfo | null {
    const fullMatch = match[0];

    const baseInfo: Partial<SymbolInfo> = {
      line,
      column,
      visibility: this.extractVisibility(fullMatch),
      isAsync: fullMatch.includes('async'),
      isStatic: fullMatch.includes('static'),
      isExported: fullMatch.includes('export') || fullMatch.includes('pub') || (language === 'go' && /^[A-Z]/.test(match[1] || '')),
    };

    switch (symbolType) {
      case 'function':
        return { name: match[1], type: 'function', signature: this.extractSignature(fullMatch), ...baseInfo } as SymbolInfo;
      case 'class':
      case 'struct':
        return { name: match[1], type: 'class', signature: this.extractSignature(fullMatch), ...baseInfo } as SymbolInfo;
      case 'interface':
      case 'trait':
        return { name: match[1], type: 'interface', signature: this.extractSignature(fullMatch), ...baseInfo } as SymbolInfo;
      case 'type':
      case 'enum':
        return { name: match[1], type: 'type', ...baseInfo } as SymbolInfo;
      case 'const':
        return { name: match[1], type: 'constant', ...baseInfo } as SymbolInfo;
      case 'method':
        return { name: language === 'java' ? match[2] : match[1], type: 'method', signature: this.extractSignature(fullMatch), ...baseInfo } as SymbolInfo;
      default:
        return null;
    }
  }

  private extractVisibility(match: string): 'public' | 'private' | 'protected' | undefined {
    if (match.includes('private')) return 'private';
    if (match.includes('protected')) return 'protected';
    if (match.includes('public') || match.includes('pub')) return 'public';
    return undefined;
  }

  private extractSignature(match: string): string {
    return match.replace(/\s+/g, ' ').replace(/\s*\{$/, '').replace(/\s*:$/, '').trim();
  }

  private detectFramework(content: string, filePath: string): FrameworkType | undefined {
    for (const { pattern, framework } of FRAMEWORK_PATTERNS) {
      if (pattern.test(content) || pattern.test(filePath)) return framework;
    }
    return undefined;
  }

  private isEntryPoint(filePath: string, exports: ExportInfo[]): boolean {
    const basename = path.basename(filePath);
    if (['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'main.py', 'app.py', 'main.go', 'main.rs', 'Main.java'].includes(basename)) {
      return true;
    }
    return exports.some((e) => e.isDefault);
  }

  private isTestFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    const dirname = path.dirname(filePath);
    return (
      basename.includes('.test.') || basename.includes('.spec.') || basename.includes('_test.') ||
      basename.startsWith('test_') || basename.endsWith('_test.py') || basename.endsWith('_test.go') ||
      basename.endsWith('Test.java') || dirname.includes('__tests__') || dirname.includes('/test/') || dirname.includes('/tests/')
    );
  }

  private isConfigFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    return (
      basename.includes('config') || basename.includes('settings') || basename.endsWith('.json') ||
      basename.endsWith('.yaml') || basename.endsWith('.yml') || basename.endsWith('.toml') ||
      basename === 'package.json' || basename === 'tsconfig.json' || basename === '.eslintrc.js' ||
      basename === 'webpack.config.js' || basename === 'vite.config.ts' || basename === 'Cargo.toml' ||
      basename === 'go.mod' || basename === 'pyproject.toml' || basename === 'setup.py'
    );
  }

  private getLineNumber(content: string, offset: number): number {
    return content.slice(0, offset).split('\n').length - 1;
  }

  private getColumnNumber(content: string, offset: number): number {
    const before = content.slice(0, offset);
    const lastNewline = before.lastIndexOf('\n');
    return offset - lastNewline - 1;
  }
}

let metadataExtractorInstance: MetadataExtractor | null = null;

export function getMetadataExtractor(): MetadataExtractor {
  if (!metadataExtractorInstance) {
    metadataExtractorInstance = new MetadataExtractor();
  }
  return metadataExtractorInstance;
}

export function resetMetadataExtractor(): void {
  metadataExtractorInstance = null;
}
