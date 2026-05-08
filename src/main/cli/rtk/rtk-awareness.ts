/**
 * RTK awareness prompt — short instruction block injected into provider
 * prompts that don't have a programmatic PreToolUse hook (Codex, Gemini,
 * Copilot). Tells the model to prefix shell commands with `rtk` so the
 * filter pipeline runs and 60–90% of bash output noise is removed before
 * it returns to context.
 *
 * Sourced from `rtk/hooks/codex/rtk-awareness.md` upstream and trimmed to
 * the load-bearing lines. ~500 chars — well under any provider's prompt
 * cap, safe to prepend on every turn.
 */
export const RTK_AWARENESS_PROMPT = `# RTK (Token Killer) — active in this session

When you run shell commands, prefix them with \`rtk\` so output is token-compressed.

Examples:
- \`rtk git status\` (not \`git status\`)
- \`rtk cargo test\` (not \`cargo test\`)
- \`rtk npm run build\` (not \`npm run build\`)
- \`rtk pytest -q\` (not \`pytest -q\`)

If a raw command is needed, use \`rtk proxy <cmd>\` to bypass filtering.
Use \`rtk gain\` to inspect savings.`;

/** Keep awareness blocks consistent — wrap with the same delimiters used
 *  for the existing system prompt sentinel in the Codex adapter so they
 *  parse symmetrically in transcripts. */
export function wrapRtkAwareness(): string {
  return [
    '[RTK AWARENESS]',
    RTK_AWARENESS_PROMPT,
    '[/RTK AWARENESS]',
  ].join('\n');
}
