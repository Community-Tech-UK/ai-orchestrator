/**
 * Skill Types - Progressive loading skill system
 * Validated design from Claude Code skill loading patterns
 */

export interface SkillMetadata {
  name: string;
  description: string;
  triggers: string[]; // Phrases that activate skill
  version: string;
  author?: string;
  category?: string;
  icon?: string;

  /**
   * Model effort level override for this skill.
   * Skills can declare their required effort so verification skills use high
   * effort while formatting skills use low effort — saving tokens.
   * Inspired by Claude Code 2.1.76/2.1.80 per-skill effort frontmatter.
   */
  effort?: 'low' | 'medium' | 'high';

  /**
   * Preferred model override for this skill.
   * When set, instances executing this skill will use this model
   * instead of the default. Supports tier names (fast/balanced/powerful)
   * or concrete model IDs.
   */
  preferredModel?: string;

  // Progressive loading hints
  coreSize?: number; // SKILL.md size in bytes
  referenceCount?: number;
  exampleCount?: number;
}

export interface SkillBundle {
  id: string;
  path: string; // Directory path
  metadata: SkillMetadata;

  // Content paths
  corePath: string; // SKILL.md
  referencePaths: string[]; // references/*.md
  examplePaths: string[]; // examples/*.md
  scriptPaths: string[]; // scripts/*
  assetPaths: string[]; // assets/*
}

export interface LoadedSkill {
  bundle: SkillBundle;
  coreContent: string;
  loadedReferences: Map<string, string>;
  loadedExamples: Map<string, string>;
  loadTime: number;
  tokenEstimate: number;
}

export interface SkillMatch {
  skill: SkillBundle;
  trigger: string;
  confidence: number; // 0-1 match confidence
}

// Skill loading state
export type SkillLoadState = 'unloaded' | 'loading' | 'loaded' | 'error';

export interface SkillState {
  bundle: SkillBundle;
  loadState: SkillLoadState;
  loaded?: LoadedSkill;
  error?: string;
}

// IPC payload types
export interface SkillDiscoverPayload {
  searchPaths: string[];
}

export interface SkillLoadPayload {
  skillId: string;
}

export interface SkillLoadReferencePayload {
  skillId: string;
  referencePath: string;
}

export interface SkillLoadExamplePayload {
  skillId: string;
  examplePath: string;
}

export interface SkillMatchPayload {
  text: string;
}

export interface SkillUnloadPayload {
  skillId: string;
}

// Events
export type SkillEventType =
  | 'skill:discovered'
  | 'skill:loaded'
  | 'skill:unloaded'
  | 'skill:matched'
  | 'skill:reference-loaded'
  | 'skill:example-loaded'
  | 'skill:error';

export interface SkillEvent {
  type: SkillEventType;
  skill?: SkillBundle;
  loaded?: LoadedSkill;
  match?: SkillMatch;
  error?: string;
}

// Helper functions
export function createSkillBundle(
  path: string,
  metadata: SkillMetadata,
  corePath: string
): SkillBundle {
  return {
    id: `skill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    path,
    metadata,
    corePath,
    referencePaths: [],
    examplePaths: [],
    scriptPaths: [],
    assetPaths: [],
  };
}

export function estimateTokens(content: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(content.length / 4);
}

export function calculateMatchConfidence(trigger: string, text: string): number {
  const normalizedTrigger = trigger.toLowerCase().trim();
  const normalizedText = text.toLowerCase().trim();

  // Exact match
  if (normalizedText === normalizedTrigger) {
    return 1.0;
  }

  // Contains match - confidence based on trigger length relative to text
  if (normalizedText.includes(normalizedTrigger)) {
    return normalizedTrigger.length / normalizedText.length;
  }

  // Word-by-word partial match
  const triggerWords = normalizedTrigger.split(/\s+/);
  const textWords = normalizedText.split(/\s+/);
  const matchedWords = triggerWords.filter((tw) =>
    textWords.some((t) => t.includes(tw) || tw.includes(t))
  );

  return matchedWords.length / triggerWords.length;
}

// Skill directory structure validation
export function validateSkillDirectory(files: string[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const hasSkillMd = files.some((f) => f.endsWith('SKILL.md') || f.endsWith('skill.md'));
  if (!hasSkillMd) {
    errors.push('Missing SKILL.md file');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Parse SKILL.md frontmatter
export function parseSkillFrontmatter(content: string): SkillMetadata | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return null;
  }

  const yaml = frontmatterMatch[1];
  const metadata: SkillMetadata = {
    name: '',
    description: '',
    triggers: [],
    version: '1.0.0',
  };

  // Simple YAML parsing
  const lines = yaml.split('\n');
  let inTriggers = false;
  const triggers: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('triggers:')) {
      inTriggers = true;
      continue;
    }

    if (inTriggers) {
      if (line.trim().startsWith('-')) {
        const trigger = line
          .replace(/^\s*-\s*/, '')
          .trim()
          .replace(/^["']|["']$/g, '');
        triggers.push(trigger);
        continue;
      } else if (!line.startsWith(' ') && !line.startsWith('\t')) {
        inTriggers = false;
      }
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim();
    const value = line
      .substring(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    switch (key) {
      case 'name':
        metadata.name = value;
        break;
      case 'description':
        metadata.description = value;
        break;
      case 'version':
        metadata.version = value;
        break;
      case 'author':
        metadata.author = value;
        break;
      case 'category':
        metadata.category = value;
        break;
      case 'icon':
        metadata.icon = value;
        break;
      case 'effort':
        if (value === 'low' || value === 'medium' || value === 'high') {
          metadata.effort = value;
        }
        break;
      case 'preferredModel':
      case 'preferred_model':
      case 'model':
        metadata.preferredModel = value;
        break;
    }
  }

  metadata.triggers = triggers;

  // Validate required fields
  if (!metadata.name || metadata.triggers.length === 0) {
    return null;
  }

  return metadata;
}

// Remove frontmatter from skill content
export function removeSkillFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

// Serialize for IPC transport
export function serializeLoadedSkill(skill: LoadedSkill): {
  bundle: SkillBundle;
  coreContent: string;
  references: Record<string, string>;
  examples: Record<string, string>;
  loadTime: number;
  tokenEstimate: number;
} {
  return {
    bundle: skill.bundle,
    coreContent: skill.coreContent,
    references: Object.fromEntries(skill.loadedReferences),
    examples: Object.fromEntries(skill.loadedExamples),
    loadTime: skill.loadTime,
    tokenEstimate: skill.tokenEstimate,
  };
}
