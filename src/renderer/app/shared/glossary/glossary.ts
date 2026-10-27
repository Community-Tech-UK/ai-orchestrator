/**
 * Define what a word means for the user, in everyday words, in roughly 25 words.
 * Expand acronyms; keep one name per concept; never quote changeable numbers.
 * Consequences needed to decide belong beside the control, not only in a hint.
 */
import { UI_TERMS } from '../../../../shared/copy/ui-vocabulary';
import type { HelpTarget } from '../help/help-target';

export interface GlossaryEntry {
  readonly label: string;
  readonly term?: string;
  readonly plain: string;
  readonly aliases?: readonly string[];
  readonly learnMore?: HelpTarget;
}

function canonical(id: string): Pick<GlossaryEntry, 'label' | 'term' | 'plain'> {
  const row = UI_TERMS.find(term => term.id === id);
  if (!row) throw new Error(`Missing vocabulary term: ${id}`);
  return { label: row.use, term: id, plain: row.meaning };
}

export const GLOSSARY = {
  'auto-approve': { ...canonical('auto-approve'), aliases: ['YOLO'] },
  'fast-mode': { label: 'Fast mode', aliases: ['FAST'], plain: 'Quicker replies using a provider’s faster service option. Availability and any extra cost depend on the model.' },
  rtk: { label: 'Output compression', aliases: ['RTK'], plain: 'Rust Token Killer (RTK) shortens command output before the agent reads it, so fewer tokens are used.' },
  'learning-database': { label: 'Learning database', aliases: ['RLM'], plain: 'A store of context and patterns agents can look up later, using a Recursive Language Model (RLM).', learnMore: { surface: 'rlm' } },
  'code-index': { label: 'Code index', aliases: ['codemem'], plain: 'Harness’s searchable index of your code helps agents find definitions and uses without reading whole files.', learnMore: { surface: 'search' } },
  'tool-servers': { ...canonical('tool-servers'), aliases: ['MCP'], learnMore: { surface: 'mcp' } },
  connectors: { ...canonical('connectors'), learnMore: { surface: 'mcp' } },
  'code-intelligence': { label: 'Code intelligence', aliases: ['LSP'], plain: 'Language Server Protocol (LSP) connects a language’s helper to find definitions, references and code errors.', learnMore: { surface: 'lsp' } },
  acp: { label: 'ACP', plain: 'Agent Client Protocol (ACP) is a standard way for Harness to talk to some agent tools.' },
  worktree: { label: 'Worktree', aliases: ['Separate working copy'], plain: 'A separate working copy of your project, so an agent’s changes do not touch your current working folder.', learnMore: { surface: 'worktrees' } },
  'helper-models': { ...canonical('helper-models'), aliases: ['aux'], learnMore: { surface: 'models' } },
  shortening: { ...canonical('shortening'), aliases: ['compaction'] },
  'fresh-start': { label: 'Fresh start', aliases: ['recycle'], plain: 'In a loop, starts a new conversation with a short summary when the old one gets full, where the provider supports it.' },
  'same-session': { label: 'Same session', plain: 'The loop keeps one conversation going between rounds where the provider supports it.' },
  'new-session-each-round': { label: 'New session each round', aliases: ['fresh child'], plain: 'Each loop round starts a new conversation and reloads its progress from files.' },
  'finish-by-checks': { label: 'Finish by checks', aliases: ['gated'], plain: 'The loop checks evidence of completion, including your check command and any required plan rename.' },
  'finish-by-reviews': { label: 'Finish by reviews', aliases: ['review-driven'], plain: 'The loop finishes after clean self-reviews in a row, passing configured checks and any enabled independent review.' },
  'back-and-forth-review': { label: 'Back-and-forth review', aliases: ['ping-pong'], plain: 'A second model checks each completion claim. The loop finishes when the review agrees, or stops when a safety limit is reached.' },
  'independent-review': { label: 'Independent review', aliases: ['fresh-eyes'], plain: 'A reviewer that did not do the work checks it before the loop may finish.' },
  'final-round': { label: 'Final tidy-up round', aliases: ['wrap-up'], plain: 'A final turn to write hand-off notes after a round or time limit, when enabled and supported by the provider.' },
  'retry-new-approach': { label: 'Retry with a new approach', aliases: ['unstick'], plain: 'The loop saw no progress and asked the agent to change approach. The number of attempts is limited.' },
  'set-aside': { label: 'Set aside', aliases: ['parked'], plain: 'Work the loop could not finish is kept with a reason for setting it aside.' },
  steer: { label: 'Send now', aliases: ['steer'], plain: 'A message sent while the agent is working, ahead of other queued messages, to change what it does next.' },
  'side-chat': { label: 'Side chat', plain: 'A separate conversation beside the main session, so you can ask something without interrupting it.' },
  asleep: { ...canonical('asleep'), aliases: ['hibernated'] },
  'context-window': { label: 'Context window', aliases: ['occupancy'], plain: 'How much text the model can hold in mind at once. Older conversation text may be shortened when it fills up.' },
  'ask-several-models': { label: 'Ask several models', aliases: ['council'], plain: 'Sends one question to several artificial intelligence models at once and shows their answers side by side.', learnMore: { surface: 'ask-council' } },
  'second-opinion': { ...canonical('second-opinion') },
  'helper-agent': { ...canonical('helper-agent'), aliases: ['subagent'] },
  tokens: { label: 'Tokens', plain: 'The small pieces of text a model reads and writes. Usage limits and costs are counted in them.' },
  'cache-read-write': { label: 'Cache read and write', plain: 'Some providers charge less to reuse recently seen text. Adding new text to that cache can have a separate charge.', learnMore: { surface: 'cost' } },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryTermId = keyof typeof GLOSSARY;
export function glossaryLabel(id: GlossaryTermId): string { return GLOSSARY[id].label; }
export function glossaryPlain(id: GlossaryTermId): string { return GLOSSARY[id].plain; }
export function termTooltip(id: GlossaryTermId): string { return glossaryPlain(id); }

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const GLOSSARY_PATTERNS: readonly { id: GlossaryTermId; pattern: RegExp }[] =
  (Object.entries(GLOSSARY) as [GlossaryTermId, GlossaryEntry][]).flatMap(([id, entry]) =>
    [entry.label, ...(entry.aliases ?? [])].map(name => ({
      id, pattern: new RegExp(`\\b${escapePattern(name)}s?\\b`, 'i'),
    })),
  );
