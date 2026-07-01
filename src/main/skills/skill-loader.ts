/**
 * Skill Loader
 * Handles progressive loading of skill content (core -> references -> examples)
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  SkillBundle,
  LoadedSkill,
} from '../../shared/types/skill.types';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import {
  createSkillIgnoreMatcher,
  parseSkillMetadata,
  validateSkillName,
  type SkillIgnoreMatcher,
} from './skill-spec';

const MAX_CACHED_SKILLS = 50;

// Local type for load level
export type SkillLoadLevel = 'core' | 'references' | 'full';

export interface SkillLoadOptions {
  loadReferences?: boolean;
  loadExamples?: boolean;
  maxTokens?: number;
}

export class SkillLoader extends EventEmitter {
  private static instance: SkillLoader | null = null;
  private loadedSkills = new Map<string, LoadedSkill>();
  private tokenEstimator: (text: string) => number;

  static getInstance(): SkillLoader {
    if (!this.instance) {
      this.instance = new SkillLoader();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    // Shared CJK-aware heuristic (Latin text == legacy ~4 chars/token).
    this.tokenEstimator = (text: string) => sharedEstimateTokens(text);
  }

  // ============ Skill Discovery ============

  async discoverSkills(searchPaths: string[]): Promise<SkillBundle[]> {
    const bundles: SkillBundle[] = [];

    for (const searchPath of searchPaths) {
      try {
        const entries = await fs.readdir(searchPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillPath = path.join(searchPath, entry.name);
            const resolvedPath = path.resolve(skillPath);
            if (!resolvedPath.startsWith(path.resolve(searchPath) + path.sep)) {
              console.warn('Blocked path traversal in skill directory', { skillPath, searchPath });
              continue;
            }
            const bundle = await this.loadSkillBundle(skillPath);
            if (bundle) {
              bundles.push(bundle);
            }
          }
        }
      } catch {
        /* intentionally ignored: skill bundle directory may not exist */
      }
    }

    return bundles;
  }

  private async loadSkillBundle(skillPath: string): Promise<SkillBundle | null> {
    try {
      // Check for SKILL.md (required)
      const corePath = path.join(skillPath, 'SKILL.md');
      const resolvedFile = path.resolve(corePath);
      if (!resolvedFile.startsWith(path.resolve(skillPath) + path.sep)) {
        throw new Error(`Path traversal blocked: ${corePath}`);
      }
      await fs.access(corePath);

      // Read and parse metadata from SKILL.md frontmatter
      const coreContent = await fs.readFile(corePath, 'utf-8');
      const metadata = parseSkillMetadata(coreContent, path.basename(skillPath));

      // Task 12: enforce strict skill names. Reject-and-skip (with a diagnostic)
      // rather than failing the whole skill load, so one bad skill can't take
      // out the rest.
      const nameCheck = validateSkillName(metadata.name);
      if (!nameCheck.ok) {
        console.warn('Skipping skill with invalid name', {
          skillPath,
          name: metadata.name,
          reason: nameCheck.reason,
        });
        return null;
      }

      // Task 12: honor a `.skillignore` at the skill root so generated caches,
      // screenshots, and large fixtures are not loaded as skill content.
      const ignoreMatcher = await createSkillIgnoreMatcher(skillPath);

      // Discover references
      const referencePaths = await this.discoverFiles(path.join(skillPath, 'references'), skillPath, ignoreMatcher);

      // Discover examples
      const examplePaths = await this.discoverFiles(path.join(skillPath, 'examples'), skillPath, ignoreMatcher);

      // Discover scripts
      const scriptPaths = await this.discoverFiles(path.join(skillPath, 'scripts'), skillPath, ignoreMatcher);

      // Discover assets
      const assetPaths = await this.discoverFiles(path.join(skillPath, 'assets'), skillPath, ignoreMatcher);

      return {
        id: `skill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        path: skillPath,
        metadata,
        corePath,
        referencePaths,
        examplePaths,
        scriptPaths,
        assetPaths,
      };
    } catch {
      return null;
    }
  }

  private async discoverFiles(
    dirPath: string,
    skillRoot: string,
    ignoreMatcher: SkillIgnoreMatcher,
  ): Promise<string[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(e => e.isFile())
        .map(e => path.join(dirPath, e.name))
        .filter(full => !ignoreMatcher.ignores(path.relative(skillRoot, full)));
    } catch {
      return [];
    }
  }

  // ============ Progressive Loading ============

  async loadSkill(bundle: SkillBundle, options?: SkillLoadOptions): Promise<LoadedSkill> {
    const existingSkill = this.loadedSkills.get(bundle.metadata.name);
    if (existingSkill) {
      return existingSkill;
    }

    const loadStart = Date.now();

    // Always load core content
    const coreContent = await fs.readFile(bundle.corePath, 'utf-8');

    const loadedSkill: LoadedSkill = {
      bundle,
      coreContent,
      loadedReferences: new Map(),
      loadedExamples: new Map(),
      loadTime: Date.now() - loadStart,
      tokenEstimate: this.tokenEstimator(coreContent),
    };

    // Optionally load references
    if (options?.loadReferences) {
      await this.loadReferences(loadedSkill, options.maxTokens);
    }

    // Optionally load examples
    if (options?.loadExamples) {
      await this.loadExamples(loadedSkill, options.maxTokens);
    }

    // LRU eviction: remove oldest entry if cache is full
    if (this.loadedSkills.size >= MAX_CACHED_SKILLS) {
      const oldestKey = this.loadedSkills.keys().next().value;
      if (oldestKey) {
        this.loadedSkills.delete(oldestKey);
      }
    }
    this.loadedSkills.set(bundle.metadata.name, loadedSkill);
    this.emit('skill:loaded', { name: bundle.metadata.name, level: this.getLoadLevel(loadedSkill) });

    return loadedSkill;
  }

  async loadReference(skillName: string, referencePath: string): Promise<string | null> {
    const skill = this.loadedSkills.get(skillName);
    if (!skill) return null;

    // Check if already loaded
    const existing = skill.loadedReferences.get(referencePath);
    if (existing) return existing;

    try {
      const content = await fs.readFile(referencePath, 'utf-8');
      skill.loadedReferences.set(referencePath, content);
      this.emit('reference:loaded', { skillName, referencePath });
      return content;
    } catch {
      return null;
    }
  }

  async loadExample(skillName: string, examplePath: string): Promise<string | null> {
    const skill = this.loadedSkills.get(skillName);
    if (!skill) return null;

    // Check if already loaded
    const existing = skill.loadedExamples.get(examplePath);
    if (existing) return existing;

    try {
      const content = await fs.readFile(examplePath, 'utf-8');
      skill.loadedExamples.set(examplePath, content);
      this.emit('example:loaded', { skillName, examplePath });
      return content;
    } catch {
      return null;
    }
  }

  private async loadReferences(skill: LoadedSkill, maxTokens?: number): Promise<void> {
    let totalTokens = this.tokenEstimator(skill.coreContent);

    for (const refPath of skill.bundle.referencePaths) {
      if (maxTokens && totalTokens >= maxTokens) break;

      try {
        const content = await fs.readFile(refPath, 'utf-8');
        const tokens = this.tokenEstimator(content);

        if (!maxTokens || totalTokens + tokens <= maxTokens) {
          skill.loadedReferences.set(refPath, content);
          totalTokens += tokens;
        }
      } catch {
        /* intentionally ignored: failed skill file loads are skipped gracefully */
      }
    }
  }

  private async loadExamples(skill: LoadedSkill, maxTokens?: number): Promise<void> {
    let totalTokens =
      this.tokenEstimator(skill.coreContent) +
      Array.from(skill.loadedReferences.values()).reduce((sum, ref) => sum + this.tokenEstimator(ref), 0);

    for (const exPath of skill.bundle.examplePaths) {
      if (maxTokens && totalTokens >= maxTokens) break;

      try {
        const content = await fs.readFile(exPath, 'utf-8');
        const tokens = this.tokenEstimator(content);

        if (!maxTokens || totalTokens + tokens <= maxTokens) {
          skill.loadedExamples.set(exPath, content);
          totalTokens += tokens;
        }
      } catch {
        /* intentionally ignored: failed skill file loads are skipped gracefully */
      }
    }
  }

  // ============ Skill Management ============

  unloadSkill(skillName: string): boolean {
    const removed = this.loadedSkills.delete(skillName);
    if (removed) {
      this.emit('skill:unloaded', { name: skillName });
    }
    return removed;
  }

  getLoadedSkill(skillName: string): LoadedSkill | undefined {
    return this.loadedSkills.get(skillName);
  }

  hasSkill(skillName: string): boolean {
    return this.loadedSkills.has(skillName);
  }

  /**
   * Store a pre-built LoadedSkill in the cache directly (used by SkillRegistry
   * to delegate cache storage without going through the full load path).
   * Applies the same LRU eviction as loadSkill().
   */
  cacheSkill(skillName: string, skill: LoadedSkill): void {
    if (this.loadedSkills.size >= MAX_CACHED_SKILLS) {
      const oldestKey = this.loadedSkills.keys().next().value;
      if (oldestKey) {
        this.loadedSkills.delete(oldestKey);
      }
    }
    this.loadedSkills.set(skillName, skill);
  }

  getCachedSkillCount(): number {
    return this.loadedSkills.size;
  }

  getAllCachedSkills(): IterableIterator<LoadedSkill> {
    return this.loadedSkills.values();
  }

  getLoadedSkills(): LoadedSkill[] {
    return Array.from(this.loadedSkills.values());
  }

  getLoadLevel(skill: LoadedSkill): SkillLoadLevel {
    if (skill.loadedExamples.size > 0) return 'full';
    if (skill.loadedReferences.size > 0) return 'references';
    return 'core';
  }

  // ============ Token Estimation ============

  estimateTokens(skill: LoadedSkill): number {
    let total = this.tokenEstimator(skill.coreContent);

    for (const ref of skill.loadedReferences.values()) {
      total += this.tokenEstimator(ref);
    }

    for (const example of skill.loadedExamples.values()) {
      total += this.tokenEstimator(example);
    }

    return total;
  }

  // ============ Content Compilation ============

  compileSkillContent(skill: LoadedSkill): string {
    const parts: string[] = [];

    // Core content (without frontmatter)
    const coreWithoutFrontmatter = skill.coreContent.replace(/^---\n[\s\S]*?\n---\n/, '');
    parts.push(`# ${skill.bundle.metadata.name}\n`);
    parts.push(coreWithoutFrontmatter);

    // References
    if (skill.loadedReferences.size > 0) {
      parts.push('\n## References\n');
      for (const [refPath, content] of skill.loadedReferences) {
        const refName = path.basename(refPath, path.extname(refPath));
        parts.push(`### ${refName}\n`);
        parts.push(content);
      }
    }

    // Examples
    if (skill.loadedExamples.size > 0) {
      parts.push('\n## Examples\n');
      for (const [exPath, content] of skill.loadedExamples) {
        const exName = path.basename(exPath, path.extname(exPath));
        parts.push(`### ${exName}\n`);
        parts.push(content);
      }
    }

    return parts.join('\n');
  }
}

// Export singleton getter
export function getSkillLoader(): SkillLoader {
  return SkillLoader.getInstance();
}
