/**
 * Codebase Miner
 *
 * Reads high-signal project files from a working directory and extracts:
 * - KG facts (project name, tech stack, dependencies)
 * - Wake hints (project description, key instructions)
 *
 * The miner is intentionally metadata-first. It does not crawl arbitrary source
 * files; codemem/indexing owns full-code search. Mining is idempotent through a
 * persisted content fingerprint so project folders can be mined automatically.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import * as miningStore from '../persistence/rlm/rlm-codebase-mining';
import * as projectKnowledgeStore from '../persistence/rlm/rlm-project-knowledge';
import { getKnowledgeGraphService } from './knowledge-graph-service';
import { getWakeContextBuilder } from './wake-context-builder';
import { normalizeProjectMemoryKey } from './project-memory-key';
import type {
  CodebaseMiningFileSnapshot,
  CodebaseMiningResult,
  CodebaseMiningStatus,
  ProjectKnowledgeSource,
  ProjectKnowledgeSourceDescriptor,
  ProjectKnowledgeSourceKind,
} from '../../shared/types/knowledge-graph.types';

const logger = getLogger('CodebaseMiner');

interface MineSource {
  configFile: string;
  filePath: string;
  sourceKind: ProjectKnowledgeSourceKind;
  sourceUri: string;
  sourceTitle: string;
  content: string;
  originalSize: number;
  hash: string;
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

/** Key dependencies that indicate tech stack (dependency name -> topic) */
const NOTABLE_DEPS = new Map<string, string>([
  ['react', 'frontend'], ['next', 'frontend'], ['vue', 'frontend'], ['angular', 'frontend'], ['svelte', 'frontend'],
  ['express', 'backend'], ['fastify', 'backend'], ['koa', 'backend'], ['hono', 'backend'], ['nestjs', 'backend'],
  ['prisma', 'database'], ['drizzle', 'database'], ['typeorm', 'database'], ['mongoose', 'database'], ['better-sqlite3', 'database'],
  ['vitest', 'testing'], ['jest', 'testing'], ['mocha', 'testing'], ['playwright', 'testing'], ['cypress', 'testing'],
  ['typescript', 'language'], ['zod', 'validation'], ['electron', 'desktop'], ['tailwindcss', 'styling'],
]);

const MANIFEST_PRIORITY = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
const HIGH_SIGNAL_SOURCE_KINDS: ProjectKnowledgeSourceKind[] = [
  'manifest',
  'readme',
  'instruction_doc',
  'config',
];

export class CodebaseMiner extends EventEmitter {
  private static instance: CodebaseMiner | null = null;
  private inflight = new Map<string, Promise<CodebaseMiningResult>>();

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
   * Skips only when the persisted source-file fingerprint is unchanged.
   */
  async mineDirectory(dirPath: string): Promise<CodebaseMiningResult> {
    const normalizedDir = normalizeProjectMemoryKey(dirPath) || path.resolve(dirPath);
    const existing = this.inflight.get(normalizedDir);

    if (existing) {
      return existing;
    }

    const promise = this.mineDirectoryInternal(normalizedDir);
    this.inflight.set(normalizedDir, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(normalizedDir);
    }
  }

  /**
   * Check whether a directory has been mined, backed by persisted status.
   */
  getStatus(dirPath: string): CodebaseMiningStatus {
    const normalizedDir = normalizeProjectMemoryKey(dirPath) || path.resolve(dirPath);
    const status = miningStore.getMiningStatus(this.db, normalizedDir);

    return status ?? {
      mined: false,
      normalizedPath: normalizedDir,
      rootPath: normalizedDir,
      projectKey: normalizedDir,
      displayName: displayNameForPath(normalizedDir),
      discoverySource: 'manual',
      autoMine: true,
      isPaused: false,
      isExcluded: false,
      status: 'never',
    };
  }

  private get db() {
    return getRLMDatabase().getRawDb();
  }

  private async mineDirectoryInternal(normalizedDir: string): Promise<CodebaseMiningResult> {
    const sources = await this.collectMineSources(normalizedDir);
    const files = sources.map(sourceToSnapshot);
    const contentFingerprint = fingerprintSources(files);
    const registeredRoot = miningStore.ensureProjectRoot(this.db, {
      normalizedPath: normalizedDir,
      rootPath: normalizedDir,
      projectKey: normalizedDir,
      displayName: displayNameForPath(normalizedDir),
      discoverySource: 'manual',
      lastActiveAt: Date.now(),
    });
    const priorStatus = miningStore.getMiningStatus(this.db, normalizedDir);

    if (
      priorStatus?.status === 'completed'
      && priorStatus.contentFingerprint === contentFingerprint
      && projectKnowledgeStore.hasCurrentProjectKnowledgeSources(this.db, normalizedDir, sources.map(sourceToKnowledgeDescriptor))
    ) {
      logger.debug('Directory mining fingerprint unchanged, skipping', { dirPath: normalizedDir });
      return {
        normalizedPath: normalizedDir,
        ...miningMetadata(priorStatus),
        status: 'completed',
        factsExtracted: 0,
        hintsCreated: 0,
        filesRead: files.length,
        errors: [],
        skipped: true,
        skipReason: 'unchanged',
        contentFingerprint,
        lastMinedAt: priorStatus.completedAt,
        sourcesProcessed: 0,
        sourcesCreated: 0,
        sourcesChanged: 0,
        sourcesDeleted: 0,
        sourceLinksCreated: 0,
        sourceLinksPruned: 0,
      };
    }

    const startedAt = Date.now();
    miningStore.beginMining(this.db, normalizedDir, contentFingerprint, files, startedAt);

    const result: CodebaseMiningResult = {
      normalizedPath: normalizedDir,
      ...miningMetadata(registeredRoot),
      status: 'completed',
      factsExtracted: 0,
      hintsCreated: 0,
      filesRead: sources.length,
      errors: [],
      contentFingerprint,
      sourcesProcessed: 0,
      sourcesCreated: 0,
      sourcesChanged: 0,
      sourcesDeleted: 0,
      sourceLinksCreated: 0,
      sourceLinksPruned: 0,
    };

    try {
      const projectName = this.detectProjectName(sources, normalizedDir);
      const projectRoom = normalizeProjectMemoryKey(normalizedDir) || normalizedDir;
      const applyProvenance = this.db.transaction(() => {
        result.sourcesDeleted = HIGH_SIGNAL_SOURCE_KINDS.reduce((deleted, sourceKind) => {
          const sourceUris = sources
            .filter((source) => source.sourceKind === sourceKind)
            .map((source) => source.sourceUri);
          return deleted + projectKnowledgeStore.deleteProjectKnowledgeSourcesByKindNotSeen(
            this.db,
            normalizedDir,
            sourceKind,
            sourceUris,
          );
        }, 0);

        for (const source of sources) {
          const upsert = projectKnowledgeStore.upsertProjectKnowledgeSource(this.db, {
            projectKey: normalizedDir,
            sourceKind: source.sourceKind,
            sourceUri: source.sourceUri,
            sourceTitle: source.sourceTitle,
            contentFingerprint: source.hash,
            metadata: {
              relativePath: source.configFile,
              originalSize: source.originalSize,
            },
          });
          result.sourcesProcessed = (result.sourcesProcessed ?? 0) + 1;
          if (upsert.created) {
            result.sourcesCreated = (result.sourcesCreated ?? 0) + 1;
          }
          if (upsert.changed) {
            result.sourcesChanged = (result.sourcesChanged ?? 0) + 1;
            result.sourceLinksPruned = (result.sourceLinksPruned ?? 0)
              + projectKnowledgeStore.clearProjectKnowledgeLinksForSource(
                this.db,
                normalizedDir,
                upsert.source.id,
                ['kg_triple', 'wake_hint'],
              );
          }

          if (source.configFile === 'package.json') {
            this.extractPackageJsonFacts(source, upsert.source, normalizedDir, result, projectName);
          } else if (source.configFile === 'tsconfig.json') {
            this.extractTsconfigFacts(source, upsert.source, normalizedDir, result, projectName);
          } else if (source.configFile === 'README.md') {
            this.extractReadmeHints(source, upsert.source, result, projectRoom);
          } else if (
            source.configFile === 'CLAUDE.md'
            || source.configFile === '.claude/CLAUDE.md'
            || source.configFile === 'AGENTS.md'
          ) {
            this.extractInstructionHints(source, upsert.source, result, projectRoom);
          } else if (source.configFile === 'Cargo.toml') {
            this.extractCargoFacts(source, upsert.source, normalizedDir, result, projectName);
          } else if (source.configFile === 'pyproject.toml') {
            this.extractPyprojectFacts(source, upsert.source, normalizedDir, result, projectName);
          } else if (source.configFile === 'go.mod') {
            this.extractGoModFacts(source, upsert.source, normalizedDir, result, projectName);
          }
        }
      });
      applyProvenance();

      const completedAt = Date.now();
      result.lastMinedAt = completedAt;
      miningStore.completeMining(this.db, {
        normalizedPath: normalizedDir,
        contentFingerprint,
        files,
        factsExtracted: result.factsExtracted,
        hintsCreated: result.hintsCreated,
        filesRead: result.filesRead,
        errors: result.errors,
        startedAt,
        completedAt,
      });

      this.emit('codebase:mine-complete', { dirPath: normalizedDir, ...result });
      logger.info('Codebase mining complete', { dirPath: normalizedDir, ...result });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = Date.now();
      result.status = 'failed';
      result.errors.push(message);

      miningStore.failMining(this.db, {
        normalizedPath: normalizedDir,
        contentFingerprint,
        files,
        filesRead: result.filesRead,
        errors: result.errors,
        startedAt,
        completedAt,
      });

      logger.warn('Codebase mining failed', { dirPath: normalizedDir, error: message });
      return result;
    }
  }

  private async collectMineSources(normalizedDir: string): Promise<MineSource[]> {
    const sources: MineSource[] = [];

    for (const configFile of CONFIG_FILES) {
      const filePath = path.join(normalizedDir, configFile);
      try {
        const content = String(await fs.readFile(filePath, 'utf-8'));
        const trimmed = content.length > MAX_FILE_SIZE ? content.slice(0, MAX_FILE_SIZE) : content;
        sources.push({
          configFile,
          filePath,
          sourceKind: sourceKindForConfigFile(configFile),
          sourceUri: path.resolve(filePath),
          sourceTitle: configFile,
          content: trimmed,
          originalSize: Buffer.byteLength(content, 'utf8'),
          hash: crypto.createHash('sha256').update(content).digest('hex'),
        });
      } catch {
        // File doesn't exist or is unreadable. Mining should stay best-effort.
      }
    }

    return sources;
  }

  private detectProjectName(sources: MineSource[], dirPath: string): string {
    for (const manifest of MANIFEST_PRIORITY) {
      const source = sources.find((candidate) => candidate.configFile === manifest);
      const name = source ? this.extractProjectName(manifest, source.content) : null;
      if (name) {
        return name;
      }
    }

    return path.basename(dirPath);
  }

  private extractProjectName(configFile: string, content: string): string | null {
    if (configFile === 'package.json') {
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        return typeof pkg['name'] === 'string' && pkg['name'] ? pkg['name'] : null;
      } catch {
        return null;
      }
    }

    if (configFile === 'go.mod') {
      const moduleMatch = content.match(/^module\s+(\S+)/m);
      return moduleMatch ? path.basename(moduleMatch[1]) : null;
    }

    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    return nameMatch ? nameMatch[1] : null;
  }

  private extractPackageJsonFacts(
    source: MineSource,
    sourceRecord: ProjectKnowledgeSource,
    dirPath: string,
    result: CodebaseMiningResult,
    projectName: string,
  ): void {
    try {
      const content = source.content;
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const kg = getKnowledgeGraphService();

      kg.addEntity(projectName, 'project', { path: dirPath, manifest: 'package.json' });
      result.factsExtracted++;

      const allDeps = {
        ...((pkg['dependencies'] as Record<string, string> | undefined) ?? {}),
        ...((pkg['devDependencies'] as Record<string, string> | undefined) ?? {}),
      };

      for (const [depName] of Object.entries(allDeps)) {
        const topic = NOTABLE_DEPS.get(depName);
        if (topic) {
          const tripleId = kg.addFact(projectName, `uses_${topic}`, depName, {
            confidence: 1.0,
            sourceFile: source.sourceUri,
          });
          this.linkKgFact(sourceRecord, tripleId, result);
          result.factsExtracted++;
        }
      }

      const notableDeps = Object.keys(allDeps).filter((depName) => NOTABLE_DEPS.has(depName));
      if (notableDeps.length > 0) {
        this.addProjectHint(dirPath, `Tech stack: ${notableDeps.join(', ')}`, 7, result, sourceRecord);
      }
    } catch (error) {
      result.errors.push(`package.json parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private extractTsconfigFacts(
    source: MineSource,
    sourceRecord: ProjectKnowledgeSource,
    dirPath: string,
    result: CodebaseMiningResult,
    projectName: string,
  ): void {
    try {
      const content = source.content;
      const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped) as Record<string, unknown>;
      const kg = getKnowledgeGraphService();
      const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown> | undefined;

      if (compilerOptions?.['strict'] === true) {
        const tripleId = kg.addFact(projectName, 'typescript_config', 'strict mode enabled', {
          confidence: 1.0,
          sourceFile: source.sourceUri,
        });
        this.linkKgFact(sourceRecord, tripleId, result);
        result.factsExtracted++;
      }

      const target = compilerOptions?.['target'];
      if (typeof target === 'string') {
        const tripleId = kg.addFact(projectName, 'typescript_target', target, {
          confidence: 1.0,
          sourceFile: source.sourceUri,
        });
        this.linkKgFact(sourceRecord, tripleId, result);
        result.factsExtracted++;
      }
    } catch {
      // tsconfig parse failure is not critical.
    }
  }

  private extractReadmeHints(
    source: MineSource,
    sourceRecord: ProjectKnowledgeSource,
    result: CodebaseMiningResult,
    room: string,
  ): void {
    const content = source.content;
    const lines = content.split('\n');
    const heading = lines.find((line) => line.startsWith('# '));
    const firstParagraph = lines
      .filter((line) => !line.startsWith('#') && line.trim().length > 0)
      .slice(0, 3)
      .join(' ')
      .trim()
      .slice(0, 300);

    if (heading || firstParagraph) {
      const description = heading
        ? `${heading.replace(/^#\s+/, '')}: ${firstParagraph}`
        : firstParagraph;

      const hintId = this.addHintIfMissing(description.slice(0, 300), 6, room, result);
      this.linkWakeHint(sourceRecord, hintId, result);
    }
  }

  private extractInstructionHints(
    source: MineSource,
    sourceRecord: ProjectKnowledgeSource,
    result: CodebaseMiningResult,
    room: string,
  ): void {
    const content = source.content;
    const lines = content.split('\n');
    const instructionLines = lines.filter((line) => {
      const trimmed = line.trim();
      return (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\./.test(trimmed))
        && trimmed.length > 20
        && trimmed.length < 200;
    });

    for (const line of instructionLines.slice(0, 5)) {
      const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      const hintId = this.addHintIfMissing(cleaned, 8, room, result);
      this.linkWakeHint(sourceRecord, hintId, result);
    }

    if (instructionLines.length === 0 && content.length > 50) {
      const firstParagraph = content
        .split('\n\n')
        .find((paragraph) => paragraph.trim().length > 30 && !paragraph.startsWith('#'));
      if (firstParagraph) {
        const hintId = this.addHintIfMissing(`[${source.configFile}] ${firstParagraph.trim().slice(0, 250)}`, 7, room, result);
        this.linkWakeHint(sourceRecord, hintId, result);
      }
    }
  }

  private extractCargoFacts(
    source: MineSource,
    sourceRecord: ProjectKnowledgeSource,
    dirPath: string,
    result: CodebaseMiningResult,
    projectName: string,
  ): void {
    const content = source.content;
    const kg = getKnowledgeGraphService();
    const tripleId = kg.addFact(projectName, 'uses_language', 'Rust', {
      confidence: 1.0,
      sourceFile: source.sourceUri,
    });
    this.linkKgFact(sourceRecord, tripleId, result);
    result.factsExtracted++;

    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      kg.addEntity(nameMatch[1], 'project', { language: 'rust', path: dirPath });
      result.factsExtracted++;
    }
  }

  private extractPyprojectFacts(
    source: MineSource,
    sourceRecord: ProjectKnowledgeSource,
    dirPath: string,
    result: CodebaseMiningResult,
    projectName: string,
  ): void {
    const content = source.content;
    const kg = getKnowledgeGraphService();
    const tripleId = kg.addFact(projectName, 'uses_language', 'Python', {
      confidence: 1.0,
      sourceFile: source.sourceUri,
    });
    this.linkKgFact(sourceRecord, tripleId, result);
    result.factsExtracted++;

    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      kg.addEntity(nameMatch[1], 'project', { language: 'python', path: dirPath });
      result.factsExtracted++;
    }
  }

  private extractGoModFacts(
    source: MineSource,
    sourceRecord: ProjectKnowledgeSource,
    dirPath: string,
    result: CodebaseMiningResult,
    projectName: string,
  ): void {
    const content = source.content;
    const kg = getKnowledgeGraphService();
    const tripleId = kg.addFact(projectName, 'uses_language', 'Go', {
      confidence: 1.0,
      sourceFile: source.sourceUri,
    });
    this.linkKgFact(sourceRecord, tripleId, result);
    result.factsExtracted++;

    const moduleMatch = content.match(/^module\s+(\S+)/m);
    if (moduleMatch) {
      kg.addEntity(moduleMatch[1], 'project', { language: 'go', path: dirPath });
      result.factsExtracted++;
    }
  }

  private addProjectHint(
    dirPath: string,
    content: string,
    importance: number,
    result: CodebaseMiningResult,
    sourceRecord?: ProjectKnowledgeSource,
  ): void {
    const room = normalizeProjectMemoryKey(dirPath) || dirPath;
    const hintId = this.addHintIfMissing(content, importance, room, result);
    if (sourceRecord) {
      this.linkWakeHint(sourceRecord, hintId, result);
    }
  }

  private addHintIfMissing(
    content: string,
    importance: number,
    room: string,
    result: CodebaseMiningResult,
  ): string | undefined {
    const trimmed = content.trim();
    if (!trimmed) {
      return undefined;
    }

    const wake = getWakeContextBuilder();
    const existing = wake
      .listHints(room)
      .find((hint) => (
        hint.room === room
        && normalizeHintContent(hint.content) === normalizeHintContent(trimmed)
      ));

    if (existing) {
      return existing.id;
    }

    const hintId = wake.addHint(trimmed, { importance, room });
    result.hintsCreated++;
    return hintId;
  }

  private linkKgFact(
    sourceRecord: ProjectKnowledgeSource,
    tripleId: string | undefined,
    result: CodebaseMiningResult,
  ): void {
    if (!tripleId) {
      return;
    }
    const link = projectKnowledgeStore.linkProjectKnowledgeKgTriple(this.db, {
      projectKey: sourceRecord.projectKey,
      sourceId: sourceRecord.id,
      tripleId,
    });
    if (link.created) {
      result.sourceLinksCreated = (result.sourceLinksCreated ?? 0) + 1;
    }
  }

  private linkWakeHint(
    sourceRecord: ProjectKnowledgeSource,
    hintId: string | undefined,
    result: CodebaseMiningResult,
  ): void {
    if (!hintId) {
      return;
    }
    const link = projectKnowledgeStore.linkProjectKnowledgeWakeHint(this.db, {
      projectKey: sourceRecord.projectKey,
      sourceId: sourceRecord.id,
      hintId,
    });
    if (link.created) {
      result.sourceLinksCreated = (result.sourceLinksCreated ?? 0) + 1;
    }
  }
}

export function getCodebaseMiner(): CodebaseMiner {
  return CodebaseMiner.getInstance();
}

function sourceToSnapshot(source: MineSource): CodebaseMiningFileSnapshot {
  return {
    relativePath: source.configFile,
    hash: source.hash,
    size: source.originalSize,
  };
}

function sourceToKnowledgeDescriptor(source: MineSource): ProjectKnowledgeSourceDescriptor {
  return {
    sourceKind: source.sourceKind,
    sourceUri: source.sourceUri,
    contentFingerprint: source.hash,
  };
}

function fingerprintSources(files: CodebaseMiningFileSnapshot[]): string {
  const hash = crypto.createHash('sha256');

  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.hash);
    hash.update('\0');
    hash.update(String(file.size));
    hash.update('\0');
  }

  return hash.digest('hex');
}

function normalizeHintContent(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, ' ');
}

function sourceKindForConfigFile(configFile: string): ProjectKnowledgeSourceKind {
  if (configFile === 'README.md') {
    return 'readme';
  }
  if (configFile === 'CLAUDE.md' || configFile === '.claude/CLAUDE.md' || configFile === 'AGENTS.md') {
    return 'instruction_doc';
  }
  if (configFile === 'tsconfig.json') {
    return 'config';
  }
  return 'manifest';
}

function displayNameForPath(dirPath: string): string {
  return path.basename(dirPath) || dirPath;
}

function miningMetadata(status: CodebaseMiningStatus): Pick<
  CodebaseMiningResult,
  'rootPath' | 'projectKey' | 'displayName' | 'discoverySource' | 'autoMine' | 'isPaused' | 'isExcluded'
> {
  return {
    rootPath: status.rootPath,
    projectKey: status.projectKey,
    displayName: status.displayName,
    discoverySource: status.discoverySource,
    autoMine: status.autoMine,
    isPaused: status.isPaused,
    isExcluded: status.isExcluded,
  };
}
