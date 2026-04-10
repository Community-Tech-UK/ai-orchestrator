/**
 * Codebase Miner
 *
 * Reads known config files from a working directory and extracts:
 * - KG facts (project name, tech stack, dependencies)
 * - Wake hints (project description, key instructions)
 * - Verbatim segments (README, CLAUDE.md content)
 *
 * Designed to run once per directory, with deduplication.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { getKnowledgeGraphService } from './knowledge-graph-service';
import { getWakeContextBuilder } from './wake-context-builder';

const logger = getLogger('CodebaseMiner');

interface MineResult {
  factsExtracted: number;
  hintsCreated: number;
  filesRead: number;
  errors: string[];
  skipped?: boolean;
}

/** Files to look for, in priority order */
const CONFIG_FILES = [
  'package.json',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.claude/CLAUDE.md',
  'tsconfig.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
];

/** Maximum chars to read from any single file */
const MAX_FILE_SIZE = 20_000;

/** Key dependencies that indicate tech stack (dependency name → topic) */
const NOTABLE_DEPS = new Map<string, string>([
  ['react', 'frontend'], ['next', 'frontend'], ['vue', 'frontend'], ['angular', 'frontend'], ['svelte', 'frontend'],
  ['express', 'backend'], ['fastify', 'backend'], ['koa', 'backend'], ['hono', 'backend'], ['nestjs', 'backend'],
  ['prisma', 'database'], ['drizzle', 'database'], ['typeorm', 'database'], ['mongoose', 'database'], ['better-sqlite3', 'database'],
  ['vitest', 'testing'], ['jest', 'testing'], ['mocha', 'testing'], ['playwright', 'testing'], ['cypress', 'testing'],
  ['typescript', 'language'], ['zod', 'validation'], ['electron', 'desktop'], ['tailwindcss', 'styling'],
]);

export class CodebaseMiner extends EventEmitter {
  private static instance: CodebaseMiner | null = null;
  private minedDirectories = new Set<string>();

  static getInstance(): CodebaseMiner {
    if (!this.instance) {
      this.instance = new CodebaseMiner();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    logger.info('CodebaseMiner initialized');
  }

  /**
   * Mine a directory for config files and extract knowledge.
   * Skips if directory was already mined in this session.
   */
  async mineDirectory(dirPath: string): Promise<MineResult> {
    const normalizedDir = path.resolve(dirPath);

    if (this.minedDirectories.has(normalizedDir)) {
      logger.debug('Directory already mined, skipping', { dirPath: normalizedDir });
      return { factsExtracted: 0, hintsCreated: 0, filesRead: 0, errors: [], skipped: true };
    }

    this.minedDirectories.add(normalizedDir);

    const result: MineResult = { factsExtracted: 0, hintsCreated: 0, filesRead: 0, errors: [] };

    for (const configFile of CONFIG_FILES) {
      const filePath = path.join(normalizedDir, configFile);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const trimmed = content.length > MAX_FILE_SIZE ? content.slice(0, MAX_FILE_SIZE) : content;
        result.filesRead++;

        if (configFile === 'package.json') {
          this.extractPackageJsonFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'tsconfig.json') {
          this.extractTsconfigFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'README.md') {
          this.extractReadmeHints(trimmed, normalizedDir, result);
        } else if (configFile === 'CLAUDE.md' || configFile === '.claude/CLAUDE.md' || configFile === 'AGENTS.md') {
          this.extractInstructionHints(trimmed, configFile, normalizedDir, result);
        } else if (configFile === 'Cargo.toml') {
          this.extractCargoFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'pyproject.toml') {
          this.extractPyprojectFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'go.mod') {
          this.extractGoModFacts(trimmed, normalizedDir, result);
        }
      } catch {
        // File doesn't exist — that's fine, not an error
      }
    }

    this.emit('codebase:mine-complete', { dirPath: normalizedDir, ...result });
    logger.info('Codebase mining complete', { dirPath: normalizedDir, ...result });

    return result;
  }

  private extractPackageJsonFacts(content: string, dirPath: string, result: MineResult): void {
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const kg = getKnowledgeGraphService();
      const projectName = (pkg['name'] as string) || path.basename(dirPath);

      // Create project entity
      kg.addEntity(projectName, 'project', { path: dirPath });
      result.factsExtracted++;

      // Extract notable dependencies
      const allDeps = {
        ...(pkg['dependencies'] as Record<string, string> || {}),
        ...(pkg['devDependencies'] as Record<string, string> || {}),
      };

      for (const [depName] of Object.entries(allDeps)) {
        const topic = NOTABLE_DEPS.get(depName);
        if (topic) {
          kg.addFact(projectName, `uses_${topic}`, depName, {
            confidence: 1.0,
            sourceFile: path.join(dirPath, 'package.json'),
          });
          result.factsExtracted++;
        }
      }

      // Create a tech stack wake hint
      const notableDeps = Object.keys(allDeps).filter((d) => NOTABLE_DEPS.has(d));
      if (notableDeps.length > 0) {
        const wake = getWakeContextBuilder();
        wake.addHint(`Tech stack: ${notableDeps.join(', ')}`, {
          importance: 7,
          room: 'architecture',
        });
        result.hintsCreated++;
      }
    } catch (error) {
      result.errors.push(`package.json parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private extractTsconfigFacts(content: string, dirPath: string, result: MineResult): void {
    try {
      // tsconfig can have comments — strip them for JSON parsing
      const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped) as Record<string, unknown>;
      const kg = getKnowledgeGraphService();
      const projectName = path.basename(dirPath);
      const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown> | undefined;

      if (compilerOptions) {
        if (compilerOptions['strict'] === true) {
          kg.addFact(projectName, 'typescript_config', 'strict mode enabled', {
            confidence: 1.0,
            sourceFile: path.join(dirPath, 'tsconfig.json'),
          });
          result.factsExtracted++;
        }
        const target = compilerOptions['target'] as string | undefined;
        if (target) {
          kg.addFact(projectName, 'typescript_target', target, {
            confidence: 1.0,
            sourceFile: path.join(dirPath, 'tsconfig.json'),
          });
          result.factsExtracted++;
        }
      }
    } catch {
      // tsconfig parse failure — not critical
    }
  }

  private extractReadmeHints(content: string, _dirPath: string, result: MineResult): void {
    const wake = getWakeContextBuilder();

    // Extract first heading + first paragraph as project description
    const lines = content.split('\n');
    const heading = lines.find((l) => l.startsWith('# '));
    const firstParagraph = lines
      .filter((l) => !l.startsWith('#') && l.trim().length > 0)
      .slice(0, 3)
      .join(' ')
      .trim()
      .slice(0, 300);

    if (heading || firstParagraph) {
      const description = heading
        ? `${heading.replace(/^#\s+/, '')}: ${firstParagraph}`
        : firstParagraph;

      wake.addHint(description.slice(0, 300), {
        importance: 6,
        room: 'project',
      });
      result.hintsCreated++;
    }
  }

  private extractInstructionHints(content: string, fileName: string, _dirPath: string, result: MineResult): void {
    const wake = getWakeContextBuilder();

    // Extract key instructions (lines that look like rules/instructions)
    const lines = content.split('\n');
    const instructionLines = lines.filter((l) => {
      const trimmed = l.trim();
      // Look for bullet points, numbered lists, or imperative sentences
      return (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\./.test(trimmed))
        && trimmed.length > 20
        && trimmed.length < 200;
    });

    // Take top 5 instruction lines
    for (const line of instructionLines.slice(0, 5)) {
      const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      wake.addHint(cleaned, {
        importance: 8,
        room: 'instructions',
      });
      result.hintsCreated++;
    }

    if (instructionLines.length === 0 && content.length > 50) {
      // Fall back to first meaningful paragraph
      const firstParagraph = content
        .split('\n\n')
        .find((p) => p.trim().length > 30 && !p.startsWith('#'));
      if (firstParagraph) {
        wake.addHint(`[${fileName}] ${firstParagraph.trim().slice(0, 250)}`, {
          importance: 7,
          room: 'instructions',
        });
        result.hintsCreated++;
      }
    }
  }

  private extractCargoFacts(content: string, dirPath: string, result: MineResult): void {
    const kg = getKnowledgeGraphService();
    const projectName = path.basename(dirPath);
    kg.addFact(projectName, 'uses_language', 'Rust', {
      confidence: 1.0,
      sourceFile: path.join(dirPath, 'Cargo.toml'),
    });
    result.factsExtracted++;

    // Extract package name from [package] section
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      kg.addEntity(nameMatch[1], 'project', { language: 'rust', path: dirPath });
      result.factsExtracted++;
    }
  }

  private extractPyprojectFacts(content: string, dirPath: string, result: MineResult): void {
    const kg = getKnowledgeGraphService();
    const projectName = path.basename(dirPath);
    kg.addFact(projectName, 'uses_language', 'Python', {
      confidence: 1.0,
      sourceFile: path.join(dirPath, 'pyproject.toml'),
    });
    result.factsExtracted++;

    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      kg.addEntity(nameMatch[1], 'project', { language: 'python', path: dirPath });
      result.factsExtracted++;
    }
  }

  private extractGoModFacts(content: string, dirPath: string, result: MineResult): void {
    const kg = getKnowledgeGraphService();
    const projectName = path.basename(dirPath);
    kg.addFact(projectName, 'uses_language', 'Go', {
      confidence: 1.0,
      sourceFile: path.join(dirPath, 'go.mod'),
    });
    result.factsExtracted++;

    const moduleMatch = content.match(/^module\s+(\S+)/m);
    if (moduleMatch) {
      kg.addEntity(moduleMatch[1], 'project', { language: 'go', path: dirPath });
      result.factsExtracted++;
    }
  }
}

export function getCodebaseMiner(): CodebaseMiner {
  return CodebaseMiner.getInstance();
}
