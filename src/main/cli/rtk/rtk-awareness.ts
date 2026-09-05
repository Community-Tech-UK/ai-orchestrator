/**
 * RTK awareness prompt — short instruction block injected into provider
 * prompts that don't have a programmatic PreToolUse hook (Codex, Gemini,
 * Copilot). Tells the model to prefix shell commands with `rtk` so the
 * supported output filters run before results return to context. Actual
 * compression depends on the command and output; proxy bypasses filtering.
 *
 * Sourced from `rtk/hooks/codex/rtk-awareness.md` upstream and trimmed to
 * the load-bearing lines and producer-side evidence guidance. Inject once per
 * persistent session; every spawn only when
 * `supportsResume === false`. Do not prepend on every Codex/ACP resume turn.
 */
export const RTK_AWARENESS_PROMPT = `# RTK (Token Killer) — active in this session

When you run shell commands, prefix them with \`rtk\` so output is token-compressed.

Examples:
- \`rtk git status\` (not \`git status\`)
- \`rtk cargo test\` (not \`cargo test\`)
- \`rtk npm run build\` (not \`npm run build\`)
- \`rtk pytest -q\` (not \`pytest -q\`)

Prefer supported RTK commands. Use \`rtk proxy <cmd>\` only when filtering is unsupported or would lose required evidence.
For large test/build output, keep full logs locally and return the exit status, concise results, failure details, and log path. Preserve the command's actual exit status when redirecting or piping output; a truncated or missing result is not proof of success.
Select relevant files with targeted searches first. Full-file investigation requirements still apply: read every required file completely, using sequential chunks when necessary. Do not substitute a summary for required source evidence.
Avoid repeating unchanged large results; refer to retained evidence and retrieve more when needed. Use \`rtk gain\` to inspect measured savings.`;

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
