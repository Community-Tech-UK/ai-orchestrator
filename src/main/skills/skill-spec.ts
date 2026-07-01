/**
 * Skill spec compliance helpers (Pi Task 12).
 *
 * - Real YAML frontmatter parsing (js-yaml) instead of ad-hoc line splitting, so
 *   values containing colons, quotes, or list syntax are handled correctly.
 * - Strict skill-name validation (no path separators / uppercase / whitespace).
 * - Ignore-file support for skill content walks so generated caches, screenshots
 *   and large fixtures are not loaded as skill context.
 *
 * Pure/self-contained and independently testable.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
import * as yaml from 'js-yaml';
import { SkillFrontmatterSchema } from '@contracts/schemas/plugin';
import type { SkillMetadata } from '../../shared/types/skill.types';

/** Ignore file names read at a skill root by default. */
export const DEFAULT_SKILL_IGNORE_FILES: readonly string[] = ['.skillignore'];

export interface SkillIgnoreMatcher {
  ignores(relativePath: string): boolean;
}

export type SkillNameValidation = { ok: true } | { ok: false; reason: string };

/**
 * Strict skill-name validation. A valid name is lowercase letters, digits,
 * hyphen and underscore, with at most one colon separating an optional
 * `plugin:` prefix from the skill id — and never a path separator, whitespace,
 * or uppercase. Mirrors the skill-id shape used across the app.
 */
export function validateSkillName(name: string): SkillNameValidation {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'name is empty' };
  }
  if (name.length > 200) {
    return { ok: false, reason: 'name exceeds 200 characters' };
  }
  if (/[\\/]/.test(name)) {
    return { ok: false, reason: 'name must not contain path separators' };
  }
  if (!/^[a-z0-9_-]+(:[a-z0-9_-]+)?$/.test(name)) {
    return {
      ok: false,
      reason:
        'name must be lowercase letters, digits, hyphen or underscore, with an optional single `plugin:` prefix',
    };
  }
  return { ok: true };
}

/**
 * Parse a SKILL.md's YAML frontmatter block into a raw object using a real YAML
 * parser. Returns null when there is no `--- … ---` block or it does not parse
 * to a mapping. Never throws — malformed YAML yields null so the caller can fall
 * back or skip.
 */
export function parseSkillFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    // js-yaml v4 `load` uses the safe DEFAULT_SCHEMA — it does NOT construct
    // arbitrary JS types (`!!js/function` etc.), so parsing untrusted skill
    // frontmatter cannot execute code. (Same call the app uses elsewhere.)
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build an ignore matcher for a skill root from the given ignore file(s)
 * (default `.skillignore`), using gitignore semantics via the `ignore` package.
 * Missing ignore files are fine — the matcher then ignores nothing.
 */
/**
 * Map parsed YAML frontmatter to {@link SkillMetadata}, preserving legacy
 * singular `trigger` and falling back when Zod validation fails.
 */
export function parseSkillMetadata(content: string, defaultName: string): SkillMetadata {
  const defaults: SkillMetadata = {
    name: defaultName,
    description: '',
    triggers: [],
    version: '1.0.0',
  };

  const parsed = parseSkillFrontmatter(content);
  if (!parsed) {
    return defaults;
  }

  const raw: Record<string, unknown> = { ...parsed };
  for (const field of ['name', 'description', 'version', 'author', 'category', 'icon', 'preferredModel', 'effort']) {
    const value = raw[field];
    if (typeof value === 'number' || typeof value === 'boolean') {
      raw[field] = String(value);
    }
  }

  // Legacy singular `trigger:` field used by built-in skills.
  if (typeof raw['trigger'] === 'string' && raw['trigger']) {
    const existing = raw['triggers'];
    if (!Array.isArray(existing) || existing.length === 0) {
      raw['triggers'] = [raw['trigger']];
    }
  }
  for (const legacyField of ['preferred_model', 'model']) {
    if (typeof raw['preferredModel'] !== 'string' && typeof raw[legacyField] === 'string') {
      raw['preferredModel'] = raw[legacyField];
    }
  }

  const result = SkillFrontmatterSchema.safeParse(raw);
  if (result.success) {
    return {
      name: result.data.name,
      description: result.data.description,
      triggers: result.data.triggers ?? [],
      version: result.data.version ?? '1.0.0',
      author: result.data.author,
      category: result.data.category,
      icon: result.data.icon,
      effort: result.data.effort,
      preferredModel: result.data.preferredModel,
    };
  }

  const preferredModel = typeof raw['preferredModel'] === 'string'
    ? raw['preferredModel']
    : getLegacyPreferredModel(raw);

  return {
    ...defaults,
    name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : defaultName,
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    version: typeof raw['version'] === 'string' && raw['version'] ? raw['version'] : '1.0.0',
    author: typeof raw['author'] === 'string' ? raw['author'] : undefined,
    category: typeof raw['category'] === 'string' ? raw['category'] : undefined,
    preferredModel,
    triggers: Array.isArray(raw['triggers'])
      ? raw['triggers'].filter((t): t is string => typeof t === 'string')
      : typeof raw['trigger'] === 'string' && raw['trigger']
        ? [raw['trigger']]
        : [],
  };
}

function getLegacyPreferredModel(raw: Record<string, unknown>): string | undefined {
  for (const field of ['preferred_model', 'model']) {
    const value = raw[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export async function createSkillIgnoreMatcher(
  skillRoot: string,
  ignoreFileNames: readonly string[] = DEFAULT_SKILL_IGNORE_FILES,
): Promise<SkillIgnoreMatcher> {
  const ig: Ignore = ignore();
  let hasPatterns = false;
  for (const fileName of ignoreFileNames) {
    try {
      const raw = await fs.readFile(path.join(skillRoot, fileName), 'utf8');
      ig.add(raw);
      hasPatterns = true;
    } catch {
      // Missing ignore file is expected.
    }
  }
  return {
    ignores(relativePath: string): boolean {
      if (!hasPatterns) return false;
      // `ignore` requires a relative POSIX path and throws on '' / absolute.
      const normalized = relativePath.split(path.sep).join('/').replace(/^\/+/, '');
      if (!normalized || normalized === '.') return false;
      return ig.ignores(normalized);
    },
  };
}
