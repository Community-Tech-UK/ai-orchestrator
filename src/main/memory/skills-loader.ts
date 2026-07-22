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
import * as os from 'os';
import * as path from 'path';
import { EmbeddingService, getEmbeddingService } from '../rlm/embedding-service';
import { getSkillAttribution } from '../skills/skill-attribution-service';
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
  /**
   * Minimum confidence for phrase-trigger matches (slash commands bypass it).
   * Confidence is trigger-length / message-length, so this gate drops triggers
   * that appear only incidentally inside long prompts.
   */
  triggerMinConfidence: number;
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
  triggerMinConfidence: 0.05, // Trigger must be >=5% of the message text
  manifestPath: '.claude/skills/skills.json',
  skillsDir: '.claude/skills',
};

/**
 * Classify where a skill's content lives. Drives the control-mode default:
 * builtins default to 'enabled', everything else to 'suggest-only' (D1a).
 */
export function resolveSkillSource(fsPath: string | undefined): 'builtin' | 'global' | 'project' {
  if (!fsPath) return 'project';
  const normalized = fsPath.split(path.sep).join('/');
  if (normalized.includes('/skills/builtin/')) return 'builtin';
  const home = os.homedir().split(path.sep).join('/');
  for (const dir of ['.agents/skills', '.claude/skills', '.codex/skills']) {
    if (normalized.startsWith(`${home}/${dir}/`)) return 'global';
  }
  return 'project';
}

// ============ Skills Loader Class ============

export class SkillsLoader extends EventEmitter {
  private static instance: SkillsLoader | null = null;
  private config: SkillsLoaderConfig;
  private embeddingService: EmbeddingService;
  private skillRegistry: SkillRegistry;
  private registryDiscoveryAttempted = false;
  private registryDiscoveryPromise: Promise<void> | null = null;

  // Skill manifest entries (from skills.json)
  private manifestSkills: Map<string, SkillManifestEntry> = new Map();

  // Names the user explicitly declared (skills.json manifest or registerSkill).
  // These are an explicit opt-in, so they default to 'enabled' rather than the
  // 'suggest-only' default applied to newly discovered non-builtin skills.
  private explicitlyDeclaredNames = new Set<string>();

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
    const skillsDirChanged =
      config.skillsDir !== undefined && config.skillsDir !== this.config.skillsDir;
    this.config = { ...this.config, ...config };
    if (skillsDirChanged) {
      this.registryDiscoveryAttempted = false;
    }
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

    await this.discoverRegistrySkills();

    // Also discover skills from SkillRegistry
    await this.syncWithRegistry();

    // Pre-compute embeddings for all skill descriptions
    if (this.config.cacheEmbeddings) {
      await this.precomputeEmbeddings();
    }

    this.emit('initialized', { totalSkills: this.manifestSkills.size });
  }

  private getRegistryDiscoveryPaths(): string[] {
    const paths = [
      this.config.skillsDir || DEFAULT_CONFIG.skillsDir,
      '.claude/skills',
      '.agents/skills',
      '.codex/skills',
    ].filter((entry): entry is string => !!entry);

    return Array.from(new Set(paths));
  }

  private async discoverRegistrySkills(): Promise<void> {
    if (this.registryDiscoveryAttempted) return;
    if (this.registryDiscoveryPromise) {
      await this.registryDiscoveryPromise;
      return;
    }

    const registryWithDiscovery = this.skillRegistry as SkillRegistry & {
      discoverSkillsWithBuiltins?: (searchPaths: string[]) => Promise<SkillBundle[]>;
    };

    if (typeof registryWithDiscovery.discoverSkillsWithBuiltins !== 'function') {
      this.registryDiscoveryAttempted = true;
      return;
    }

    this.registryDiscoveryPromise = registryWithDiscovery
      .discoverSkillsWithBuiltins(this.getRegistryDiscoveryPaths())
      .then(() => {
        this.registryDiscoveryAttempted = true;
      })
      .finally(() => {
        this.registryDiscoveryPromise = null;
      });

    await this.registryDiscoveryPromise;
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
        this.explicitlyDeclaredNames.add(entry.name);
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
      if (this.descriptionEmbeddings.has(entry.name)) continue;

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

  /**
   * The control mode to honour for a skill at selection time.
   * An explicit control always wins; user-declared skills (manifest or
   * registerSkill) default to 'enabled'; everything else falls back to the
   * source-based default ('enabled' for builtins, 'suggest-only' otherwise).
   */
  private resolveModeFor(
    name: string,
    source: 'builtin' | 'global' | 'project'
  ): 'enabled' | 'suggest-only' | 'disabled' {
    const attribution = getSkillAttribution();
    const control = attribution.getControl(name);
    if (control) return control.mode;
    if (this.explicitlyDeclaredNames.has(name)) return 'enabled';
    return attribution.getEffectiveMode(name, source);
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
    await this.discoverRegistrySkills();
    await this.syncWithRegistry();
    if (this.config.cacheEmbeddings) {
      await this.precomputeEmbeddings();
    }

    const matched: DetectedSkill[] = [];
    const seenNames = new Set<string>();

    // 1. Check trigger-based matches first (from SkillRegistry)
    const triggerMatches = this.skillRegistry.matchTrigger(userMessage);
    for (const match of triggerMatches) {
      const entry = this.manifestSkills.get(match.skill.metadata.name);
      if (!entry || seenNames.has(entry.name)) continue;

      // Phrase triggers must clear the min-confidence gate so a trigger that
      // appears only incidentally inside a long prompt does not inject.
      // Slash commands are typed deliberately and always pass.
      const isSlashTrigger = match.trigger.startsWith('/');
      if (!isSlashTrigger && match.confidence < this.config.triggerMinConfidence) {
        continue;
      }

      const skillSource = resolveSkillSource(match.skill.path || entry.contentPath);
      const mode = this.resolveModeFor(entry.name, skillSource);
      if (mode === 'disabled') continue;

      seenNames.add(entry.name);
      matched.push({
        name: entry.name,
        description: entry.description,
        contentPath: entry.contentPath,
        priority: entry.priority,
        similarity: match.confidence,
        source: 'trigger',
        matchedTrigger: match.trigger,
        skillSource,
        suggestOnly: mode === 'suggest-only',
      });
    }

    // 2. Check embedding-based matches when semantic lookup is available.
    try {
      const messageResult = await this.embeddingService.embed(userMessage);
      const messageEmbedding = messageResult.embedding;

      for (const [skillName, embedding] of this.descriptionEmbeddings) {
        if (seenNames.has(skillName)) continue;

        const similarity = this.embeddingService.cosineSimilarity(
          messageEmbedding,
          embedding
        );

        if (similarity >= this.config.similarityThreshold) {
          const entry = this.manifestSkills.get(skillName)!;
          const skillSource = resolveSkillSource(entry.contentPath);
          const mode = this.resolveModeFor(entry.name, skillSource);
          if (mode === 'disabled') continue;
          seenNames.add(skillName);

          matched.push({
            name: entry.name,
            description: entry.description,
            contentPath: entry.contentPath,
            priority: entry.priority,
            similarity,
            source: 'embedding',
            skillSource,
            suggestOnly: mode === 'suggest-only',
          });
        }
      }
    } catch (error) {
      this.emit('embedding:error', { query: userMessage.slice(0, 100), error });
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
  ): Promise<{
    content: string[];
    totalTokens: number;
    loaded: string[];
    loadedDetails: { name: string; tokens: number }[];
  }> {
    const content: string[] = [];
    const loaded: string[] = [];
    const loadedDetails: { name: string; tokens: number }[] = [];
    let totalTokens = 0;

    // Sort by priority then similarity
    const sorted = [...skills].sort((a, b) => {
      const priorityDiff = b.priority - a.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return b.similarity - a.similarity;
    });

    for (const skill of sorted) {
      // Kill-switch enforcement: suggest-only skills are never injected.
      if (skill.suggestOnly) continue;

      const skillContent = await this.loadSkillContent(skill);
      if (!skillContent) continue;

      const tokens = this.estimateTokens(skillContent);

      if (totalTokens + tokens <= maxTokens) {
        content.push(skillContent);
        loaded.push(skill.name);
        loadedDetails.push({ name: skill.name, tokens });
        totalTokens += tokens;
      }
    }

    return { content, totalTokens, loaded, loadedDetails };
  }

  // ============ Skill Management ============

  /**
   * Register a skill from external source (not from manifest)
   */
  registerSkill(entry: SkillManifestEntry): void {
    this.manifestSkills.set(entry.name, entry);
    this.explicitlyDeclaredNames.add(entry.name);
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
      this.explicitlyDeclaredNames.delete(skillName);
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
    this.explicitlyDeclaredNames.clear();
    this.descriptionEmbeddings.clear();
    this.registryDiscoveryAttempted = false;
    this.registryDiscoveryPromise = null;
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
