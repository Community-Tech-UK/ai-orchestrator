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
  'here as markdown checkboxes. The loop stops only when EVERY item is\n' +
  '`[x]` (done) or `[-]` (deferred, with a reason) — and verify passes.\n\n' +
  'Markers: `[ ]` todo · `[~]` in progress · `[x]` done · `[-] … — deferred: <why>`.\n\n' +
  '<!-- Example:\n- [ ] Implement the parser\n- [~] Wire the coordinator\n- [-] Cross-model fan-out — deferred: out of scope for v1\n-->\n';
