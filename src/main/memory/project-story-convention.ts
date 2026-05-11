/**
 * ProjectStoryConvention — initializes and manages the `.aio/` directory.
 *
 * Inspired by storybloq's `.story/` convention (claude3.md §13, claude2.md §23):
 * every project gets a `.aio/` directory of git-trackable markdown files that
 * agents and humans can both read without needing the opaque RLM database.
 *
 * The RLM database remains the source of truth for vector/relational queries.
 * `.aio/` is a git-trackable mirror for onboarding new agents, code-review
 * context, cross-machine sync, and audit trails.
 *
 * Directory layout:
 *   .aio/
 *     decisions.md   — architectural and design decisions (persistent)
 *     lessons.md     — lessons learned from past sessions (persistent)
 *     handovers.md   — handover notes from the last session (updated each session)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';

const logger = getLogger('ProjectStoryConvention');

const AIO_DIR = '.aio';

const SKELETON: Record<string, string> = {
  'decisions.md': `# Architectural Decisions

<!-- Record design choices and their rationale here.
     Format: ## YYYY-MM-DD — Title
     Body: context, decision, consequences. -->
`,
  'lessons.md': `# Lessons Learned

<!-- Record surprising bugs, non-obvious invariants, and hard-won knowledge.
     Format: ## YYYY-MM-DD — Short title
     Body: what happened, why it was surprising, how to avoid it next time. -->
`,
  'handovers.md': `# Session Handovers

<!-- Updated at the end of each agent session so the next session can pick up
     where this one left off without re-reading the full conversation.
     Format: ## YYYY-MM-DD HH:MM — Session summary
     Body: what was accomplished, what is still in progress, any open questions. -->
`,
};

export interface StoryConventionOptions {
  /** Project root (defaults to process.cwd()). */
  projectRoot?: string;
  /** Skip writing skeleton files if they already exist (default true). */
  skipExisting?: boolean;
}

/**
 * Ensures the `.aio/` directory and skeleton files exist.
 * Returns the absolute path to the `.aio/` directory.
 */
export function ensureProjectStoryDir(options: StoryConventionOptions = {}): string {
  const root = options.projectRoot ?? process.cwd();
  const aioDir = path.join(root, AIO_DIR);
  const skipExisting = options.skipExisting ?? true;

  if (!fs.existsSync(aioDir)) {
    fs.mkdirSync(aioDir, { recursive: true });
    logger.info('Created .aio/ project memory directory', { aioDir });
  }

  for (const [filename, content] of Object.entries(SKELETON)) {
    const filePath = path.join(aioDir, filename);
    if (skipExisting && fs.existsSync(filePath)) continue;
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info('Wrote .aio/ skeleton file', { file: filename });
  }

  return aioDir;
}

/**
 * Appends a timestamped entry to one of the `.aio/` files.
 */
export function appendToStoryFile(
  filename: 'decisions.md' | 'lessons.md' | 'handovers.md',
  title: string,
  body: string,
  options: StoryConventionOptions = {},
): void {
  const aioDir = ensureProjectStoryDir(options);
  const filePath = path.join(aioDir, filename);
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry = `\n## ${ts} — ${title}\n\n${body.trimEnd()}\n`;
  fs.appendFileSync(filePath, entry, 'utf-8');
  logger.info('Appended to .aio/ file', { file: filename, title });
}

/**
 * Reads a `.aio/` file, returning its contents or null if it doesn't exist.
 */
export function readStoryFile(
  filename: 'decisions.md' | 'lessons.md' | 'handovers.md',
  options: StoryConventionOptions = {},
): string | null {
  const root = options.projectRoot ?? process.cwd();
  const filePath = path.join(root, AIO_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}
