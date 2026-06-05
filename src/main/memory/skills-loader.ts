/**
 * Skills Loader - Embedding-based skill detection
 * Phase 2 of Memory & Context Management Enhancement Plan
 *
 * Uses semantic similarity to detect relevant skills from user messages.
 * Integrates with existing SkillRegistry for trigger-based matching
 * and adds embedding-based detection for better coverage.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService, getEmbeddingService } from '../rlm/embedding-service';
import { SkillRegistry, getSkillRegistry } from '../skills/skill-registry';
import type { SkillBundle, LoadedSkill } from '../../shared/types/skill.types';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import type {
  SkillManifest,
  SkillManifestEntry,
  DetectedSkill,
} from '../../shared/types/skills-manifest.types';

// Re-export types for convenience
export type { SkillManifest, SkillManifestEntry, DetectedSkill };

export interface SkillsLoaderConfig {
  similarityThreshold: number;
  maxResults: number;
  cacheEmbeddings: boolean;
  manifestPath?: string;
  skillsDir?: string;
}

export interface SkillsLoaderStats {
  totalSkills: number;
  cachedEmbeddings: number;
  detectionCount: number;
  avgDetectionTimeMs: number;
  lastDetectionTimeMs: number;
}

// ============ Default Configuration ============

const DEFAULT_CONFIG: SkillsLoaderConfig = {
  similarityThreshold: 0.65, // Per plan: single threshold, no LLM fallback
  maxResults: 3, // Per plan: max 3 skills to avoid context bloat
  cacheEmbeddings: true,
  manifestPath: '.claude/skills/skills.json',
  skillsDir: '.claude/skills',
};

// ============ Skills Loader Class ============

export class SkillsLoader extends EventEmitter {
  private static instance: SkillsLoader | null = null;
  private config: SkillsLoaderConfig;
  private embeddingService: EmbeddingService;
  private skillRegistry: SkillRegistry;

  // Skill manifest entries (from skills.json)
  private manifestSkills: Map<string, SkillManifestEntry> = new Map();

  // Cached embeddings for skill descriptions
  private descriptionEmbeddings: Map<string, number[]> = new Map();

  // Statistics
  private stats: SkillsLoaderStats = {
    totalSkills: 0,
    cachedEmbeddings: 0,
    detectionCount: 0,
    avgDetectionTimeMs: 0,
    lastDetectionTimeMs: 0,
  };

  // ============ Singleton ============

  static getInstance(config?: Partial<SkillsLoaderConfig>): SkillsLoader {
    if (!this.instance) {
      this.instance = new SkillsLoader(config);
    }
    return this.instance;
  }

  private constructor(config?: Partial<SkillsLoaderConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingService = getEmbeddingService();
    this.skillRegistry = getSkillRegistry();
  }

  // ============ Configuration ============

  configure(config: Partial<SkillsLoaderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SkillsLoaderConfig {
    return { ...this.config };
  }

  // ============ Initialization ============

  /**
   * Initialize the skills loader by loading the manifest and pre-computing embeddings.
   * Call this at startup with the project root path.
   */
  async initialize(projectRoot: string): Promise<void> {
    // Load skills from manifest if it exists
    const manifestPath = path.join(projectRoot, this.config.manifestPath || '.claude/skills/skills.json');
    await this.loadManifest(manifestPath);

    // Also discover skills from SkillRegistry
    await this.syncWithRegistry();

    // Pre-compute embeddings for all skill descriptions
    if (this.config.cacheEmbeddings) {
      await this.precomputeEmbeddings();
    }

    this.emit('initialized', { totalSkills: this.manifestSkills.size });
  }

  /**
   * Load skills from the manifest file (skills.json)
   */
  async loadManifest(manifestPath: string): Promise<void> {
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest: SkillManifest = JSON.parse(content);

      this.manifestSkills.clear();
      for (const entry of manifest.skills) {
        this.manifestSkills.set(entry.name, entry);
      }

      this.stats.totalSkills = this.manifestSkills.size;
      this.emit('manifest:loaded', { path: manifestPath, count: manifest.skills.length });
    } catch (error) {
      // Manifest doesn't exist or is invalid - that's OK, we'll use registry
      this.emit('manifest:notFound', { path: manifestPath });
    }
  }

  /**
   * Sync manifest entries with skills discovered by SkillRegistry
   */
  async syncWithRegistry(): Promise<void> {
    const registrySkills = this.skillRegistry.listSkills();

    for (const bundle of registrySkills) {
      // Add registry skills not already in manifest
      if (!this.manifestSkills.has(bundle.metadata.name)) {
        this.manifestSkills.set(bundle.metadata.name, {
          name: bundle.metadata.name,
          description: bundle.metadata.description,
          contentPath: bundle.corePath,
          priority: 50, // Default priority
          triggers: bundle.metadata.triggers,
          category: bundle.metadata.category,
        });
      }
    }

    this.stats.totalSkills = this.manifestSkills.size;
  }

  /**
   * Pre-compute embeddings for all skill descriptions
   */
  private async precomputeEmbeddings(): Promise<void> {
    const entries = Array.from(this.manifestSkills.values());

    for (const entry of entries) {
      if (!entry.description) continue;

      try {
        const result = await this.embeddingService.embed(entry.description);
        this.descriptionEmbeddings.set(entry.name, result.embedding);
      } catch (error) {
        this.emit('embedding:error', { skill: entry.name, error });
      }
    }

    this.stats.cachedEmbeddings = this.descriptionEmbeddings.size;
    this.emit('embeddings:computed', { count: this.descriptionEmbeddings.size });
  }

  // ============ Skill Detection ============

  /**
   * Detect relevant skills based on user message.
   * Uses EXISTING embedding service for skill detection.
   * Simple threshold-based matching - no LLM fallback.
   *
   * @param userMessage - The user's message to analyze
   * @returns Array of detected skills, sorted by similarity (max 3)
   */
  async detectRelevantSkills(userMessage: string): Promise<DetectedSkill[]> {
    const startTime = Date.now();

    // Get embedding for user message
    const messageResult = await this.embeddingService.embed(userMessage);
    const messageEmbedding = messageResult.embedding;

    const matched: DetectedSkill[] = [];
    const seenNames = new Set<string>();

    // 1. Check trigger-based matches first (from SkillRegistry)
    const triggerMatches = this.skillRegistry.matchTrigger(userMessage);
    for (const match of triggerMatches) {
      const entry = this.manifestSkills.get(match.skill.metadata.name);
      if (entry && !seenNames.has(entry.name)) {
        seenNames.add(entry.name);

        // Calculate embedding similarity if we have it cached
        let similarity = match.confidence;
        const cachedEmbedding = this.descriptionEmbeddings.get(entry.name);
        if (cachedEmbedding) {
          similarity = this.embeddingService.cosineSimilarity(
            messageEmbedding,
            cachedEmbedding
          );
        }

        matched.push({
          name: entry.name,
          description: entry.description,
          contentPath: entry.contentPath,
          priority: entry.priority,
          similarity,
          source: cachedEmbedding ? 'both' : 'trigger',
        });
      }
    }

    // 2. Check embedding-based matches
    for (const [skillName, embedding] of this.descriptionEmbeddings) {
      if (seenNames.has(skillName)) continue;

      const similarity = this.embeddingService.cosineSimilarity(
        messageEmbedding,
        embedding
      );

      if (similarity >= this.config.similarityThreshold) {
        const entry = this.manifestSkills.get(skillName)!;
        seenNames.add(skillName);

        matched.push({
          name: entry.name,
          description: entry.description,
          contentPath: entry.contentPath,
          priority: entry.priority,
          similarity,
          source: 'embedding',
        });
      }
    }

    // Sort by similarity (descending), then by priority (descending)
    matched.sort((a, b) => {
      const simDiff = b.similarity - a.similarity;
      if (Math.abs(simDiff) > 0.05) return simDiff;
      return b.priority - a.priority;
    });

    // Limit to max results
    const results = matched.slice(0, this.config.maxResults);

    // Update stats
    const detectionTime = Date.now() - startTime;
    this.stats.detectionCount++;
    this.stats.lastDetectionTimeMs = detectionTime;
    this.stats.avgDetectionTimeMs =
      (this.stats.avgDetectionTimeMs * (this.stats.detectionCount - 1) + detectionTime) /
      this.stats.detectionCount;

    this.emit('skills:detected', {
      query: userMessage.slice(0, 100),
      results,
      detectionTimeMs: detectionTime,
    });

    return results;
  }

  /**
   * Load the content of a detected skill.
   * Uses SkillRegistry for loading if the skill is registered there.
   */
  async loadSkillContent(skill: DetectedSkill): Promise<string | null> {
    // Try to load via SkillRegistry first
    const registrySkills = this.skillRegistry.listSkills();
    const registrySkill = registrySkills.find(s => s.metadata.name === skill.name);

    if (registrySkill) {
      const loaded = await this.skillRegistry.loadSkill(registrySkill.id);
      return loaded.coreContent;
    }

    // Fall back to direct file read
    try {
      const content = await fs.readFile(skill.contentPath, 'utf-8');
      return content;
    } catch (error) {
      this.emit('skill:loadError', { skill: skill.name, error });
      return null;
    }
  }

  /**
   * Load multiple skills and return their combined content.
   * Respects token budget by loading skills in priority order.
   */
  async loadSkillsWithBudget(
    skills: DetectedSkill[],
    maxTokens: number
  ): Promise<{ content: string[]; totalTokens: number; loaded: string[] }> {
    const content: string[] = [];
    const loaded: string[] = [];
    let totalTokens = 0;

    // Sort by priority then similarity
    const sorted = [...skills].sort((a, b) => {
      const priorityDiff = b.priority - a.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return b.similarity - a.similarity;
    });

    for (const skill of sorted) {
      const skillContent = await this.loadSkillContent(skill);
      if (!skillContent) continue;

      const tokens = this.estimateTokens(skillContent);

      if (totalTokens + tokens <= maxTokens) {
        content.push(skillContent);
        loaded.push(skill.name);
        totalTokens += tokens;
      }
    }

    return { content, totalTokens, loaded };
  }

  // ============ Skill Management ============

  /**
   * Register a skill from external source (not from manifest)
   */
  registerSkill(entry: SkillManifestEntry): void {
    this.manifestSkills.set(entry.name, entry);
    this.stats.totalSkills = this.manifestSkills.size;

    // Compute embedding if caching is enabled
    if (this.config.cacheEmbeddings && entry.description) {
      this.embeddingService.embed(entry.description).then(result => {
        this.descriptionEmbeddings.set(entry.name, result.embedding);
        this.stats.cachedEmbeddings = this.descriptionEmbeddings.size;
      }).catch(error => {
        this.emit('embedding:error', { skill: entry.name, error });
      });
    }

    this.emit('skill:registered', { skill: entry.name });
  }

  /**
   * Unregister a skill
   */
  unregisterSkill(skillName: string): boolean {
    const removed = this.manifestSkills.delete(skillName);
    if (removed) {
      this.descriptionEmbeddings.delete(skillName);
      this.stats.totalSkills = this.manifestSkills.size;
      this.stats.cachedEmbeddings = this.descriptionEmbeddings.size;
      this.emit('skill:unregistered', { skill: skillName });
    }
    return removed;
  }

  /**
   * Get all registered skills
   */
  listSkills(): SkillManifestEntry[] {
    return Array.from(this.manifestSkills.values());
  }

  /**
   * Get a specific skill by name
   */
  getSkill(name: string): SkillManifestEntry | undefined {
    return this.manifestSkills.get(name);
  }

  // ============ Utilities ============

  private estimateTokens(text: string): number {
    return sharedEstimateTokens(text);
  }

  // ============ Statistics ============

  getStats(): SkillsLoaderStats {
    return { ...this.stats };
  }

  // ============ Cleanup ============

  clear(): void {
    this.manifestSkills.clear();
    this.descriptionEmbeddings.clear();
    this.stats = {
      totalSkills: 0,
      cachedEmbeddings: 0,
      detectionCount: 0,
      avgDetectionTimeMs: 0,
      lastDetectionTimeMs: 0,
    };
  }

  /**
   * Reset for testing
   */
  static resetInstance(): void {
    SkillsLoader.instance = undefined as unknown as SkillsLoader;
  }

  static _resetForTesting(): void {
    SkillsLoader.instance = null;
  }
}

// ============ Singleton Accessor ============

export function getSkillsLoader(config?: Partial<SkillsLoaderConfig>): SkillsLoader {
  return SkillsLoader.getInstance(config);
}
