/**
 * The `<context_recovery>` pointer added to the post-compaction continuity
 * package (Phase 5, A11 part 1b). The block holds the fact that the earlier
 * conversation is still in the session and how `read_session` pages it; the
 * instruction to use it lives in the package's final rule, in
 * {@link CONTEXT_RECOVERY_LOOKUP_SENTENCE}, and is added only when the block
 * is present.
 *
 * The call site adds the block only when the session really has the
 * orchestrator-tools bridge (`isOrchestratorToolsBridgeAvailable`), so the
 * package never names a tool the model cannot call.
 *
 * Placement: after the `<identifier_index>` block and before the final rule of
 * the continuity package. Phase 0 step 10's named-block package
 * (`compaction-continuity.ts`) calls this builder with the complete transcript
 * count supplied by `compaction-runtime.ts` after checking bridge availability.
 */

/** Final-rule sentence; facts stay in the block, this is the one instruction. */
export const CONTEXT_RECOVERY_LOOKUP_SENTENCE =
  'When the next request needs an exact detail from before the reset, such as a file path, an error message, a '
  + 'number or a decision, look it up with the `read_session` call in `<context_recovery>` instead of guessing it.';

/** Same closing-tag escape the continuity package applies to every block. */
function escapeClosingTag(text: string): string {
  return text.replace(/<\//g, '<\\/');
}

/**
 * Build the block. With no count (or zero) the first line stays generic rather
 * than inventing a number the package cannot support.
 */
export function buildContextRecoveryBlock(messageCount?: number): string {
  const countLine = typeof messageCount === 'number' && messageCount > 0
    ? `The ${messageCount} messages before this reset are still in this session.`
    : 'The messages before this reset are still in this session.';
  const body = `${countLine} Harness's \`read_session\` tool can read them: call it with `
    + `{"session": "self", "from": "before-last-compaction"} and page back with \`before\`. `
    + 'The tool is found through the orchestrator tool search when it is not in the tool list.';
  return `<context_recovery>\n${escapeClosingTag(body)}\n</context_recovery>`;
}
