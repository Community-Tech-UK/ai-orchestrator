/**
 * Skills Manifest Types
 * Defines the structure for .claude/skills/skills.json
 *
 * The skills manifest allows projects to define skills that should be
 * loaded on-demand based on semantic similarity to user queries.
 */

// ============ Manifest Entry ============

/**
 * A single skill entry in the manifest
 */
export interface SkillManifestEntry {
  /**
   * Unique name for the skill (used as identifier)
   */
  name: string;

  /**
   * Human-readable description of what the skill provides.
   * This is used for embedding-based similarity matching.
   * Should be descriptive enough to match relevant queries.
   *
   * @example "Angular component development patterns and best practices"
   * @example "Jasmine unit testing for Angular applications"
   */
  description: string;

  /**
   * Path to the skill content file, relative to the manifest location.
   *
   * @example "angular.md"
   * @example "testing/jasmine.md"
   */
  contentPath: string;

  /**
   * Priority for loading when multiple skills match.
   * Higher values are loaded first. Range: 0-100
   *
   * @default 50
   */
  priority: number;

  /**
   * Optional trigger keywords for exact-match activation.
   * These complement embedding-based detection.
   *
   * @example ["angular", "component", "ng"]
   */
  triggers?: string[];

  /**
   * Optional category for grouping skills.
   *
   * @example "framework"
   * @example "testing"
   * @example "debugging"
   */
  category?: string;

  /**
   * Optional icon identifier for UI display.
   */
  icon?: string;

  /**
   * Optional version string for the skill content.
   */
  version?: string;

  /**
   * Optional author information.
   */
  author?: string;

  /**
   * Whether this skill should be auto-loaded at startup.
   * Use sparingly - most skills should be loaded on-demand.
   *
   * @default false
   */
  autoLoad?: boolean;

  /**
   * Maximum token budget for this skill content.
   * If not specified, uses global default.
   */
  maxTokens?: number;
}

// ============ Manifest Root ============

/**
 * Root structure of the skills.json manifest file
 */
export interface SkillManifest {
  /**
   * Manifest format version for compatibility checking.
   *
   * @example "1.0"
   */
  version: string;

  /**
   * Optional description of this skill set.
   */
  description?: string;

  /**
   * List of skill entries.
   */
  skills: SkillManifestEntry[];

  /**
   * Global configuration for skill loading.
   */
  config?: SkillManifestConfig;
}

/**
 * Global configuration options for skill loading behavior
 */
export interface SkillManifestConfig {
  /**
   * Default similarity threshold for embedding-based matching.
   * Range: 0.0-1.0. Higher values require closer matches.
   *
   * @default 0.65
   */
  similarityThreshold?: number;

  /**
   * Maximum number of skills to load per query.
   *
   * @default 3
   */
  maxSkillsPerQuery?: number;

  /**
   * Default token budget per skill.
   *
   * @default 5000
   */
  defaultMaxTokens?: number;

  /**
   * Whether to cache skill embeddings across sessions.
   *
   * @default true
   */
  cacheEmbeddings?: boolean;
}

// ============ Detected Skill ============

/**
 * A skill detected as relevant to a user query
 */
export interface DetectedSkill {
  /**
   * Name from the manifest entry
   */
  name: string;

  /**
   * Description from the manifest entry
   */
  description: string;

  /**
   * Path to the skill content
   */
  contentPath: string;

  /**
   * Priority from the manifest entry
   */
  priority: number;

  /**
   * Computed similarity score (0.0-1.0)
   */
  similarity: number;

  /**
   * How the skill was detected
   */
  source: 'embedding' | 'trigger' | 'both';

  /**
   * The exact trigger string that matched (trigger-sourced detections only).
   */
  matchedTrigger?: string;

  /**
   * Where the skill's content lives (drives control-mode defaults).
   */
  skillSource?: 'builtin' | 'global' | 'project';

  /**
   * True when the skill's control mode is 'suggest-only': it may be surfaced
   * as a suggestion but must never be auto-injected into a session.
   */
  suggestOnly?: boolean;
}

// ============ Helper Functions ============

/**
 * Create a new skill manifest entry with defaults
 */
export function createSkillEntry(
  name: string,
  description: string,
  contentPath: string,
  overrides?: Partial<SkillManifestEntry>
): SkillManifestEntry {
  return {
    name,
    description,
    contentPath,
    priority: 50,
    ...overrides,
  };
}

/**
 * Create a new skill manifest with defaults
 */
export function createSkillManifest(
  skills: SkillManifestEntry[],
  overrides?: Partial<Omit<SkillManifest, 'skills'>>
): SkillManifest {
  return {
    version: '1.0',
    skills,
    ...overrides,
  };
}

/**
 * Validate a skill manifest structure
 */
export function validateSkillManifest(manifest: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  const m = manifest as Record<string, unknown>;

  if (!m['version'] || typeof m['version'] !== 'string') {
    errors.push('Missing or invalid "version" field');
  }

  if (!Array.isArray(m['skills'])) {
    errors.push('Missing or invalid "skills" array');
  } else {
    for (let i = 0; i < m['skills'].length; i++) {
      const skill = m['skills'][i] as Record<string, unknown>;

      if (!skill['name'] || typeof skill['name'] !== 'string') {
        errors.push(`Skill ${i}: missing or invalid "name"`);
      }

      if (!skill['description'] || typeof skill['description'] !== 'string') {
        errors.push(`Skill ${i}: missing or invalid "description"`);
      }

      if (!skill['contentPath'] || typeof skill['contentPath'] !== 'string') {
        errors.push(`Skill ${i}: missing or invalid "contentPath"`);
      }

      if (skill['priority'] !== undefined && typeof skill['priority'] !== 'number') {
        errors.push(`Skill ${i}: invalid "priority" (must be number)`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
