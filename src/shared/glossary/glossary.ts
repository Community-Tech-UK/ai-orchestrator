/**
 * Define what a word means for the user, in everyday words, in roughly 25 words.
 * Expand acronyms; keep one name per concept; never quote changeable numbers.
 * Consequences needed to decide belong beside the control, not only in a hint.
 *
 * This is the single word list for the whole programme. Entries double as
 * tooltip bodies (`plain`), carry the group they belong to, may declare
 * `avoid` words that must never appear in visible text, and `flag` real
 * double meanings. `src/shared/copy/ui-vocabulary.ts` holds only maps.
 */
const APP_NAME_PATTERN = /(?<![./~\\-])\b(AIO|AI Orchestrator|Orchestrator|orchestrator)\b(?![-_./\\])/;

export type GlossaryGroup = 'Product' | 'Session' | 'Loop' | 'Models' | 'Tools' | 'Status' | 'Cost' | 'Flagged';

export interface GlossaryLearnMore {
  readonly surface?: string;
  readonly topic?: string;
  readonly anchor?: string;
}

export interface GlossaryEntry {
  readonly term?: string;
  readonly label: string;
  readonly plain: string;
  readonly group: GlossaryGroup;
  readonly aliases?: readonly string[];
  /** Words that must not appear in visible text where this term applies. */
  readonly avoid?: readonly string[];
  /** A real double meaning worth calling out. */
  readonly flag?: string;
  readonly learnMore?: GlossaryLearnMore;
  /** Migration rules for vocabulary consumers; wording is authored only here. */
  readonly vocabulary?: {
    readonly never: readonly RegExp[];
    readonly enforcement: 'zero' | 'ratchet' | 'planned';
    readonly owner?: string;
  };
}

export const GLOSSARY = {
  product: {
    term: 'product', label: 'Harness', plain: 'The app that coordinates your AI sessions.', group: 'Product', vocabulary: { never: [APP_NAME_PATTERN], enforcement: 'planned', owner: 'Phase 3 C7' },
    avoid: ['AIO', 'AI Orchestrator', 'Orchestrator'],
  },
  session: {
    term: 'session', label: 'session', plain: 'One conversation with one AI agent.', group: 'Session', vocabulary: { never: [/\binstances?\b/i, /\bthreads?\b/i], enforcement: 'planned', owner: 'Phase 3 C7' },
    avoid: ['instance', 'thread'],
  },
  job: {
    label: 'Job',
    plain: 'One piece of queue work: a whole plan, or one step of a big plan.',
    group: 'Status',
  },
  worker: {
    label: 'Worker',
    plain: 'A worker is either a computer that runs agents, or one queue agent doing one job.',
    group: 'Flagged',
    flag: 'Two meanings share this word: a worker computer, and a worker agent on the plan queue. The surrounding words say which.',
  },
  'auto-approve': { term: 'auto-approve', label: 'Auto-approve', plain: 'The agent can run tools without asking you first. Risky outside a safe folder.', group: 'Tools', vocabulary: { never: [/\bYOLO\b/i], enforcement: 'planned' }, aliases: ['YOLO'] },
  'fast-mode': { label: 'Fast mode', aliases: ['FAST'], plain: 'Quicker replies using a provider’s faster service option. Availability and any extra cost depend on the model.', group: 'Models' },
  rtk: { label: 'Output compression', aliases: ['RTK'], plain: 'Rust Token Killer (RTK) shortens command output before the agent reads it, so fewer tokens are used.', group: 'Tools' },
  'learning-database': { label: 'Learning database', aliases: ['RLM'], plain: 'A store of context and patterns agents can look up later, using a Recursive Language Model (RLM).', group: 'Tools', learnMore: { surface: 'rlm' } },
  'code-index': { label: 'Code index', aliases: ['codemem'], plain: 'Harness’s searchable index of your code helps agents find definitions and uses without reading whole files.', group: 'Tools', learnMore: { surface: 'search' } },
  'tool-servers': { term: 'tool-servers', label: 'Tool servers', aliases: ['MCP'], plain: 'Model Context Protocol (MCP) programs give agents extra abilities, such as searching a service or reading a database.', group: 'Tools', vocabulary: { never: [], enforcement: 'planned' }, learnMore: { surface: 'mcp' } },
  connectors: { term: 'connectors', label: 'Connectors', plain: 'A tool server and its sign-in, saved once in Harness for your selected local AI sessions.', group: 'Tools', vocabulary: { never: [], enforcement: 'planned' }, learnMore: { surface: 'mcp' } },
  'code-intelligence': { label: 'Code intelligence', aliases: ['LSP'], plain: 'Language Server Protocol (LSP) connects a language’s helper to find definitions, references and code errors.', group: 'Tools', learnMore: { surface: 'lsp' } },
  acp: { label: 'ACP', plain: 'Agent Client Protocol (ACP) is a standard way for Harness to talk to some agent tools.', group: 'Tools' },
  worktree: { label: 'Worktree', aliases: ['Separate working copy'], plain: 'A separate working copy of your project, so an agent’s changes do not touch your current working folder.', group: 'Tools', learnMore: { surface: 'worktrees' } },
  'helper-models': { term: 'helper-models', label: 'Helper model', plain: 'A small or local model for titles, summaries and checks.', group: 'Models', vocabulary: { never: [/\bauxiliary models?\b/i, /\baux\b/i, /\bslots?\b/i], enforcement: 'planned' }, aliases: ['aux'], learnMore: { surface: 'models' } },
  shortening: { term: 'shortening', label: 'compact', plain: 'Replaces older conversation text with a summary so it fits in the model’s memory.', group: 'Session', vocabulary: { never: [/\[native\]/, /\[restart-with-summary\]/], enforcement: 'planned', owner: 'Phase 0 compact action keeps its name' }, aliases: ['compaction'] },
  'fresh-start': { label: 'Fresh start', aliases: ['recycle'], plain: 'In a loop, starts a new conversation with a short summary when the old one gets full, where the provider supports it.', group: 'Loop' },
  'same-session': { label: 'Same session', plain: 'The loop keeps one conversation going between rounds where the provider supports it.', group: 'Loop' },
  'new-session-each-round': { label: 'New session each round', aliases: ['fresh child'], plain: 'Each loop round starts a new conversation and reloads its progress from files.', group: 'Loop' },
  'finish-by-checks': { label: 'Finish by checks', aliases: ['gated'], plain: 'The loop checks evidence of completion, including your check command and any required plan rename.', group: 'Loop' },
  'finish-by-reviews': { label: 'Finish by reviews', aliases: ['review-driven'], plain: 'The loop finishes after clean self-reviews in a row, passing configured checks and any enabled independent review.', group: 'Loop' },
  'back-and-forth-review': { label: 'Back-and-forth review', aliases: ['ping-pong'], plain: 'A second model checks each completion claim. The loop finishes when the review agrees, or stops when a safety limit is reached.', group: 'Loop' },
  'independent-review': { label: 'Independent review', aliases: ['fresh-eyes'], plain: 'A reviewer that did not do the work checks it before the loop may finish.', group: 'Loop' },
  'final-round': { label: 'Final tidy-up round', aliases: ['wrap-up'], plain: 'A final turn to write hand-off notes after a round or time limit, when enabled and supported by the provider.', group: 'Loop' },
  'retry-new-approach': { label: 'Retry with a new approach', aliases: ['unstick'], plain: 'The loop saw no progress and asked the agent to change approach. The number of attempts is limited.', group: 'Loop' },
  'set-aside': { label: 'Set aside', aliases: ['parked'], plain: 'Work the loop could not finish is kept with a reason for setting it aside.', group: 'Loop' },
  steer: { label: 'Send now', aliases: ['steer'], plain: 'A message sent while the agent is working, ahead of other queued messages, to change what it does next.', group: 'Session' },
  'side-chat': { label: 'Side chat', plain: 'A separate conversation beside the main session, so you can ask something without interrupting it.', group: 'Session' },
  asleep: { term: 'asleep', label: 'Asleep', plain: 'Harness paused this session to save memory. Send a message to wake it.', group: 'Status', vocabulary: { never: [/\bHibernating\b/i, /\bHibernated\b/i, /\bDormant\b/i], enforcement: 'planned' }, aliases: ['hibernated'] },
  'context-window': { label: 'Context window', aliases: ['occupancy'], plain: 'How much text the model can hold in mind at once. Older conversation text may be shortened when it fills up.', group: 'Models' },
  'ask-several-models': { label: 'Ask several models', aliases: ['council'], plain: 'Sends one question to several artificial intelligence models at once and shows their answers side by side.', group: 'Models', learnMore: { surface: 'ask-council' } },
  'second-opinion': { term: 'second-opinion', label: 'Second opinion', plain: 'Another model checks a finished turn that changed files and reports concerns.', group: 'Models', vocabulary: { never: [/cross-model review/i], enforcement: 'planned' } },
  'helper-agent': { term: 'helper-agent', label: 'Helper agent', plain: 'A session another session started to do part of the work.', group: 'Session', vocabulary: { never: [/\bchild instance\b/i], enforcement: 'planned' }, aliases: ['subagent'] },
  tokens: { label: 'Tokens', plain: 'The small pieces of text a model reads and writes. Usage limits and costs are counted in them.', group: 'Cost' },
  'cache-read-write': { label: 'Cache read and write', plain: 'Some providers charge less to reuse recently seen text. Adding new text to that cache can have a separate charge.', group: 'Cost', learnMore: { surface: 'cost' } },
  'working': { term: 'working', label: 'Working', plain: 'The agent is working on your request.', group: 'Status', vocabulary: { never: [/Processing…/, /\bBusy\b/, /Thinking deeply…/], enforcement: 'planned', owner: 'Phase 3 C6 presenter' } },
  'starting': { term: 'starting', label: 'Starting', plain: 'The session is starting or restarting.', group: 'Status', vocabulary: { never: [/Initializing…/, /Waking up…/, /Recovering session…/], enforcement: 'planned', owner: 'Phase 3 C6 presenter' } },
  'approval': { term: 'approval', label: 'Needs your approval', plain: 'The agent needs permission to take an action.', group: 'Status', vocabulary: { never: [/Waiting for permission/i, /Awaiting approval/i], enforcement: 'planned' } },
  'answer': { term: 'answer', label: 'Needs your answer', plain: 'The agent has asked you a question.', group: 'Status', vocabulary: { never: [/Waiting for input/i], enforcement: 'planned' } },
  'sign-off': { term: 'sign-off', label: 'Needs your sign-off', plain: 'The loop is waiting for you to accept its work.', group: 'Status', vocabulary: { never: [/Needs review/], enforcement: 'planned' } },
  'stopping': { term: 'stopping', label: 'Stopping', plain: 'The current work is stopping.', group: 'Status', vocabulary: { never: [/Interrupting…/, /Cancelling…/, /Escalating interrupt…/], enforcement: 'planned' } },
  'ready': { term: 'ready', label: 'Ready', plain: 'Waiting for your next message.', group: 'Status', vocabulary: { never: [/\bIdle\b/, /\bCancelled\b/, /\bSuperseded\b/], enforcement: 'planned' } },
  'connection-lost': { term: 'connection-lost', label: 'Connection lost', plain: 'The remote computer connection has dropped.', group: 'Status', vocabulary: { never: [/\bDegraded\b/], enforcement: 'planned' } },
  'failed': { term: 'failed', label: 'Failed', plain: 'The session failed.', group: 'Status', vocabulary: { never: [/^Error$/], enforcement: 'planned' } },
  'closed': { term: 'closed', label: 'Closed', plain: 'The session has closed.', group: 'Status', vocabulary: { never: [/\bTerminated\b/], enforcement: 'planned' } },
  'round': { term: 'round', label: 'round', plain: 'One pass of a loop.', group: 'Loop', vocabulary: { never: [/\biteration\b/i], enforcement: 'planned', owner: 'Phase 2 B9' } },
  'storage-buffers': { term: 'storage-buffers', label: 'Storage & buffers', plain: 'Settings for stored output and buffers.', group: 'Tools', vocabulary: { never: [/^Memory$/], enforcement: 'planned' } },
  'phone-chat': { term: 'phone-chat', label: 'Discord & WhatsApp', plain: 'Settings for phone chat connections.', group: 'Tools', vocabulary: { never: [/^Connections$/], enforcement: 'planned' } },
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

/** Avoid words declared by entries. Whole-word matchers that skip path and identifier spellings (`.plugins`, `-list`, `.ts`) but not sentence endings ("Selected instance."). */
export const AVOID_WORD_PATTERNS: readonly { word: string; pattern: RegExp }[] =
  [...new Set((Object.values(GLOSSARY) as GlossaryEntry[]).flatMap(entry => entry.avoid ?? []))].map(word => ({
    word,
    pattern: new RegExp(`(?<![\\w./~\\\\-])${escapePattern(word)}s?(?![\\w/\\\\-]|\\.(?=[A-Za-z]))`, 'i'),
  }));
