/**
 * SkillRegistry - Progressive loading skill system
 * Based on validated design from Claude Code skill loading patterns
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  SkillBundle,
  LoadedSkill,
  SkillMatch,
  parseSkillFrontmatter,
  removeSkillFrontmatter,
  estimateTokens,
  calculateMatchConfidence,
} from '../../shared/types/skill.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('SkillRegistry');

export class SkillRegistry extends EventEmitter {
  private static instance: SkillRegistry;
  private skills: Map<string, SkillBundle> = new Map();
  private loadedSkills: Map<string, LoadedSkill> = new Map();
  private triggerIndex: Map<string, string[]> = new Map(); // trigger -> skill IDs

  static getInstance(): SkillRegistry {
    if (!this.instance) {
      this.instance = new SkillRegistry();
    }
    return this.instance;
  }

  private constructor() {
    super();
  }

  // ============ Built-in Skills Path ============

  /**
   * Get the path to built-in orchestrator skills
   */
  getBuiltinSkillsPath(): string {
    // Built-in skills are in src/main/skills/builtin relative to the app
    return path.join(__dirname, 'builtin');
  }

  /**
   * Discover skills including built-in orchestrator skills
   */
  async discoverSkillsWithBuiltins(searchPaths: string[]): Promise<SkillBundle[]> {
    const builtinPath = this.getBuiltinSkillsPath();
    const allPaths = [builtinPath, ...searchPaths];
    return this.discoverSkills(allPaths);
  }

  // ============ Discovery ============

  async discoverSkills(searchPaths: string[]): Promise<SkillBundle[]> {
    const discovered: SkillBundle[] = [];

    for (const searchPath of searchPaths) {
      try {
        const entries = await fs.readdir(searchPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillPath = path.join(searchPath, entry.name);
            const bundle = await this.loadSkillMetadata(skillPath);
            if (bundle) {
              discovered.push(bundle);
            }
          }
        }
      } catch (error) {
        // Path doesn't exist or can't be read, skip
        logger.warn('Could not scan skill path', { searchPath, error: error instanceof Error ? error.message : String(error) });
      }
    }

    this.buildTriggerIndex();
    this.emit('skill:discovered', { count: discovered.length, skills: discovered });
    return discovered;
  }

  private async loadSkillMetadata(skillPath: string): Promise<SkillBundle | null> {
    // Try both SKILL.md and skill.md
    const possiblePaths = [
      path.join(skillPath, 'SKILL.md'),
      path.join(skillPath, 'skill.md'),
    ];

    let skillMdPath: string | null = null;
    let content: string | null = null;

    for (const p of possiblePaths) {
      try {
        content = await fs.readFile(p, 'utf-8');
        skillMdPath = p;
        break;
      } catch {
        /* intentionally ignored: file not found at this path, trying next candidate */
      }
    }

    if (!skillMdPath || !content) {
      return null;
    }

    const metadata = parseSkillFrontmatter(content);
    if (!metadata) {
      logger.warn('Invalid skill: missing or invalid frontmatter', { skillPath });
      return null;
    }

    // Calculate core size
    metadata.coreSize = Buffer.byteLength(content, 'utf-8');

    const bundle: SkillBundle = {
      id: `skill-${path.basename(skillPath)}`,
      path: skillPath,
      metadata,
      corePath: skillMdPath,
      referencePaths: await this.findFiles(skillPath, 'references'),
      examplePaths: await this.findFiles(skillPath, 'examples'),
      scriptPaths: await this.findFiles(skillPath, 'scripts'),
      assetPaths: await this.findFiles(skillPath, 'assets'),
    };

    // Update metadata counts
    metadata.referenceCount = bundle.referencePaths.length;
    metadata.exampleCount = bundle.examplePaths.length;

    this.skills.set(bundle.id, bundle);
    return bundle;
  }

  private async findFiles(basePath: string, subdir: string): Promise<string[]> {
    const dirPath = path.join(basePath, subdir);
    try {
      const entries = await fs.readdir(dirPath);
      return entries.map((e) => path.join(dirPath, e));
    } catch {
      return [];
    }
  }

  private buildTriggerIndex(): void {
    this.triggerIndex.clear();

    for (const [id, bundle] of this.skills) {
      for (const trigger of bundle.metadata.triggers) {
        const normalized = trigger.toLowerCase().trim();
        const existing = this.triggerIndex.get(normalized) || [];
        if (!existing.includes(id)) {
          existing.push(id);
        }
        this.triggerIndex.set(normalized, existing);
      }
    }
  }

  // ============ Matching ============

  matchTrigger(text: string): SkillMatch[] {
    const normalizedText = text.toLowerCase().trim();
    const matches: SkillMatch[] = [];
    const seenSkills = new Set<string>();

    for (const [trigger, skillIds] of this.triggerIndex) {
      if (normalizedText.includes(trigger)) {
        for (const skillId of skillIds) {
          if (seenSkills.has(skillId)) continue;
          seenSkills.add(skillId);

          const skill = this.skills.get(skillId)!;
          const confidence = calculateMatchConfidence(trigger, normalizedText);

          matches.push({
            skill,
            trigger,
            confidence,
          });
        }
      }
    }

    // Sort by confidence (longest match first)
    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  findBestMatch(text: string): SkillMatch | null {
    const matches = this.matchTrigger(text);
    return matches.length > 0 ? matches[0] : null;
  }

  // ============ Loading ============

  async loadSkill(skillId: string): Promise<LoadedSkill> {
    // Check cache
    if (this.loadedSkills.has(skillId)) {
      return this.loadedSkills.get(skillId)!;
    }

    const bundle = this.skills.get(skillId);
    if (!bundle) throw new Error(`Skill not found: ${skillId}`);

    const startTime = Date.now();
    const coreContent = await fs.readFile(bundle.corePath, 'utf-8');

    // Remove frontmatter for injection
    const contentWithoutFrontmatter = removeSkillFrontmatter(coreContent);

    const loaded: LoadedSkill = {
      bundle,
      coreContent: contentWithoutFrontmatter,
      loadedReferences: new Map(),
      loadedExamples: new Map(),
      loadTime: Date.now() - startTime,
      tokenEstimate: estimateTokens(contentWithoutFrontmatter),
    };

    this.loadedSkills.set(skillId, loaded);
    this.emit('skill:loaded', { skill: bundle, loaded });
    return loaded;
  }

  async loadReference(skillId: string, referencePath: string): Promise<string> {
    const loaded = this.loadedSkills.get(skillId);
    if (!loaded) throw new Error(`Skill not loaded: ${skillId}`);

    // Check if reference is valid for this skill
    if (!loaded.bundle.referencePaths.includes(referencePath)) {
      throw new Error(`Invalid reference path for skill ${skillId}: ${referencePath}`);
    }

    if (loaded.loadedReferences.has(referencePath)) {
      return loaded.loadedReferences.get(referencePath)!;
    }

    const content = await fs.readFile(referencePath, 'utf-8');
    loaded.loadedReferences.set(referencePath, content);
    loaded.tokenEstimate += estimateTokens(content);

    this.emit('skill:reference-loaded', {
      skill: loaded.bundle,
      referencePath,
      tokenEstimate: loaded.tokenEstimate,
    });

    return content;
  }

  async loadExample(skillId: string, examplePath: string): Promise<string> {
    const loaded = this.loadedSkills.get(skillId);
    if (!loaded) throw new Error(`Skill not loaded: ${skillId}`);

    // Check if example is valid for this skill
    if (!loaded.bundle.examplePaths.includes(examplePath)) {
      throw new Error(`Invalid example path for skill ${skillId}: ${examplePath}`);
    }

    if (loaded.loadedExamples.has(examplePath)) {
      return loaded.loadedExamples.get(examplePath)!;
    }

    const content = await fs.readFile(examplePath, 'utf-8');
    loaded.loadedExamples.set(examplePath, content);
    loaded.tokenEstimate += estimateTokens(content);

    this.emit('skill:example-loaded', {
      skill: loaded.bundle,
      examplePath,
      tokenEstimate: loaded.tokenEstimate,
    });

    return content;
  }

  // ============ Queries ============

  listSkills(): SkillBundle[] {
    return Array.from(this.skills.values());
  }

  getSkill(skillId: string): SkillBundle | undefined {
    return this.skills.get(skillId);
  }

  getLoadedSkill(skillId: string): LoadedSkill | undefined {
    return this.loadedSkills.get(skillId);
  }

  isSkillLoaded(skillId: string): boolean {
    return this.loadedSkills.has(skillId);
  }

  getSkillsByCategory(category: string): SkillBundle[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.metadata.category?.toLowerCase() === category.toLowerCase()
    );
  }

  // ============ Memory Management ============

  unloadSkill(skillId: string): void {
    const loaded = this.loadedSkills.get(skillId);
    if (loaded) {
      this.loadedSkills.delete(skillId);
      this.emit('skill:unloaded', { skill: loaded.bundle });
    }
  }

  unloadAllSkills(): void {
    for (const skillId of this.loadedSkills.keys()) {
      this.unloadSkill(skillId);
    }
  }

  getMemoryUsage(): {
    totalSkills: number;
    loadedSkills: number;
    estimatedTokens: number;
  } {
    let estimatedTokens = 0;
    for (const loaded of this.loadedSkills.values()) {
      estimatedTokens += loaded.tokenEstimate;
    }

    return {
      totalSkills: this.skills.size,
      loadedSkills: this.loadedSkills.size,
      estimatedTokens,
    };
  }

  // ============ Cleanup ============

  clear(): void {
    this.skills.clear();
    this.loadedSkills.clear();
    this.triggerIndex.clear();
  }

  // ============ Registration ============

  registerSkill(bundle: SkillBundle): void {
    this.skills.set(bundle.id, bundle);
    this.buildTriggerIndex();
    this.emit('skill:registered', { skill: bundle });
  }

  unregisterSkill(skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    this.unloadSkill(skillId);
    this.skills.delete(skillId);
    this.buildTriggerIndex();
    this.emit('skill:unregistered', { skill });
    return true;
  }
}

// Singleton accessor
let skillRegistryInstance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!skillRegistryInstance) {
    skillRegistryInstance = SkillRegistry.getInstance();
  }
  return skillRegistryInstance;
}
