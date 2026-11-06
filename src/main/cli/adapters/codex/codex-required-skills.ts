/**
 * Required skills for Codex sessions that run with a capped or omitted skills catalog.
 *
 * Non-chat Codex sessions cap the catalog (`skills.max_context_tokens`), and plan-queue
 * checkers in the trial's candidate arm omit it (`skills.include_instructions=false`).
 * Either can drop a skill the work depends on, so each turn selects its required skills
 * explicitly: user text uses mentions; internal instructions use exact-path skill input items.
 *
 * Verified in Codex v0.163.0 (`ext/skills/src/extension.rs` and `selection.rs`, read
 * 20 October 2026):
 * - `include_instructions=false` only stops the automatic catalog block. Explicit mentions
 *   are still collected from the turn's user input against the loaded catalog, so a named
 *   skill is injected whatever the catalog budget or the flag says.
 * - A plain `$name` mention selects the enabled catalog entry of that name. A `skill` input
 *   item is matched by exact path instead, and it also blocks the plain name, so the two
 *   forms must never be combined. Plain names do not depend on how Codex canonicalises
 *   skill paths, so ordinary user turns use them only. Internal turns use exact-path skill items,
 *   keeping their instruction text in developer history.
 * - Skills are not carried across turns; every turn that needs one re-mentions it.
 *
 * Governing instructions are never edited here. User mentions add one line after the prompt;
 * internal selection keeps that prompt in developer history. Both use installed skills only.
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillUserInput } from './app-server-types';
import type { CodexCliConfig } from '../codex-adapter-config';

/** Skills the governing fresh-eyes rules require of an independent checker. */
export const CHECKER_REQUIRED_SKILLS: readonly string[] = ['task-completion-gate'];

const SKILL_FILE = 'SKILL.md';
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CACHE_MS = 60_000;

/** The configuration a turn needs to decide which skills to name. */
export type RequiredSkillConfig = Pick<CodexCliConfig, 'sessionKind' | 'queueRole' | 'skillCatalogOmitted' | 'workingDir'>;

/** Directories Codex reads user and repository skills from, closest first. */
export function skillRoots(workingDir: string | undefined, home: string = homedir()): string[] {
  return [
    ...(workingDir ? [join(workingDir, '.agents', 'skills'), join(workingDir, '.codex', 'skills')] : []),
    join(home, '.agents', 'skills'),
    join(home, '.codex', 'skills'),
  ];
}

const discovered = new Map<string, { at: number; files: ReadonlyMap<string, string> }>();

/** Exact local skill paths, closest root first; the provider still honors disabled entries. */
function installedSkillFiles(roots: readonly string[], now: number): ReadonlyMap<string, string> {
  const key = roots.join('\n');
  const cached = discovered.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.files;
  const files = new Map<string, string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(root, entry, SKILL_FILE);
      if (SKILL_NAME.test(entry) && !files.has(entry) && existsSync(file)) files.set(entry, realpathSync(file));
    }
  }
  discovered.set(key, { at: now, files });
  return files;
}

/** Names of skills present under the roots (a folder holding `SKILL.md`), cached briefly. */
export function installedSkillNames(roots: readonly string[], now: number = Date.now()): ReadonlySet<string> {
  return new Set(installedSkillFiles(roots, now).keys());
}

export function _resetRequiredSkillsForTesting(): void {
  discovered.clear();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Installed skills the text names without a `$name` mention: the name in backticks near
 * the word "skill" ("use the `x` skill", "skill: `x`"), or "x skill" / "skill x".
 */
export function skillsNamedInText(text: string, installed: ReadonlySet<string>): string[] {
  const named: string[] = [];
  for (const name of installed) {
    if (!text.includes(name) || new RegExp(`\\$${escapeRegExp(name)}(?![A-Za-z0-9_-])`).test(text)) continue;
    const escaped = escapeRegExp(name);
    const near = new RegExp(
      `skill[^\\n]{0,40}\`${escaped}\`|\`${escaped}\`[^\\n]{0,40}skill|(?<![\\w-])${escaped}\\s+skill\\b|\\bskill\\s+${escaped}(?![\\w-])`,
      'i',
    );
    if (near.test(text)) named.push(name);
  }
  return named;
}

/**
 * Skills this turn must name. Chats keep Codex's own catalog budget, so they get none.
 * Every other kind names the installed skills its prompt refers to; a checker whose
 * catalog was omitted also names the skills the governing rules require of it.
 */
export function requiredSkillNames(
  config: RequiredSkillConfig,
  text: string,
  installed: ReadonlySet<string> = installedSkillNames(skillRoots(config.workingDir)),
): string[] {
  if (config.sessionKind === undefined || config.sessionKind === 'chat') return [];
  const names = new Set(skillsNamedInText(text, installed));
  if (config.queueRole === 'verifier' && config.skillCatalogOmitted === true) {
    for (const name of CHECKER_REQUIRED_SKILLS) if (installed.has(name)) names.add(name);
  }
  return [...names];
}

/** The turn text with one trailing line naming the required skills; unchanged when none apply. */
export function withRequiredSkillMentions(
  config: RequiredSkillConfig,
  text: string,
  installed?: ReadonlySet<string>,
): string {
  const names = requiredSkillNames(config, text, installed);
  return names.length === 0 ? text : `${text}\n\nSkills for this turn: ${names.map((name) => `$${name}`).join(' ')}`;
}

/**
 * Internal instructions stay developer-role text. Select skills via protocol metadata, not user prose.
 * Codex 0.165.0 ext/skills/src/selection.rs selects UserInput::Skill by enabled catalog path even
 * without a Text input; extension.rs injects those selections independently of include_instructions.
 * Verified 28 October 2026; official protocol: https://developers.openai.com/codex/app-server#skills.
 */
export function requiredSkillInputs(config: RequiredSkillConfig, text: string): SkillUserInput[] {
  if (config.sessionKind === undefined || config.sessionKind === 'chat') return [];
  const files = installedSkillFiles(skillRoots(config.workingDir), Date.now());
  const installed = new Set(files.keys());
  const names = new Set(requiredSkillNames(config, text, installed));
  // Explicit mentions inside developer history are not parsed by Codex's user-input selector.
  for (const name of installed) {
    if (new RegExp(`\\$${escapeRegExp(name)}(?![A-Za-z0-9_-])`).test(text)) names.add(name);
  }
  return [...names].map((name) => ({ type: 'skill', name, path: files.get(name)! }));
}
