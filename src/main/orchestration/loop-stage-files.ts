export const ARTIFACT_FILES = ['STAGE.md', 'NOTES.md', 'ITERATION_LOG.md'] as const;

/** LF-4: the structured task ledger filename. */
export const LOOP_TASKS_FILE = 'LOOP_TASKS.md';

/**
 * Deliverable filename for an investigation/audit loop (`goalIntent:
 * 'investigation'`). The agent writes its cited answer here; the completion
 * detector requires it to exist and be substantive before accepting completion.
 */
export const INVESTIGATION_REPORT_FILE = 'REPORT.md';

/** The fresh, item-less ledger template written at the start of every run. */
export const LOOP_TASKS_TEMPLATE =
  '# Loop Tasks\n\n' +
  'Structured task ledger. For a multi-item goal, list concrete work items\n' +
  'here as markdown checkboxes. The loop stops only when EVERY leaf item is\n' +
  '`[x]` (done) or `[-]` (deferred, with a reason) — and verify passes.\n\n' +
  'Markers: `[ ]` todo · `[~]` in progress · `[x]` done · `[-] … — deferred: <why>`.\n\n' +
  'Identity: give each item a stable trailing comment `<!-- loop-task-id:my.id -->`\n' +
  '(letters/digits then letters/digits/._-). NEVER change or reuse an existing id;\n' +
  'add a new unique id to every newly discovered item. Nesting: indent child items\n' +
  'two spaces under their parent — a parent row with children is only a structural\n' +
  'summary; the leaves are what must be closed.\n\n' +
  '<!-- Example:\n' +
  '- [ ] Implement the parser <!-- loop-task-id:parser -->\n' +
  '- [~] Wire the coordinator <!-- loop-task-id:coordinator -->\n' +
  '- [-] Cross-model fan-out — deferred: out of scope for v1 <!-- loop-task-id:fan-out -->\n' +
  '-->\n';
