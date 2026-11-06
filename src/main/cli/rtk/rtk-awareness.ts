/**
 * RTK awareness prompt — short instruction block injected into provider
 * prompts that don't have a programmatic PreToolUse hook (Codex, Gemini,
 * Copilot, ACP agents). Tells the model to prefix shell commands with `rtk`
 * so the supported output filters run before results return to context.
 * Actual compression depends on the command and output.
 *
 * Body is a verbatim copy of RTK 0.51.0's `hooks/rtk-awareness-full.md`
 * (build-time reading of the upstream file is impractical — the packaged app
 * does not ship RTK's source), plus one Harness sentence that scopes the
 * prefix to the shell tool and out of scripts, which is what a Codex-written
 * gate script got wrong (it wrapped every git call in `rtk proxy`, ~2,877
 * process spawns per run). Inject once per persistent session; every spawn
 * only when `supportsResume === false`. Do not prepend on every resume turn.
 */
export const RTK_AWARENESS_PROMPT = `# RTK

Type \`rtk\` in front of commands you run in the shell tool. Do not put \`rtk\` inside scripts, subprocess calls, pipelines, or any command whose output a program reads.

Prefix every shell command with \`rtk\`: \`rtk git status\`, \`rtk cargo test\`,
\`rtk npm run build\`, \`rtk ls src/\`. Keep the prefix inside chains:
\`rtk git add . && rtk git commit -m "msg"\`. Commands RTK has no filter for
run as-is, so the prefix is always safe.

# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as \`rtk proxy <cmd>\` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.

## About RTK

RTK (Rust Token Killer) is a CLI proxy that filters command output to save
tokens; behavior and exit code are unchanged.

- \`rtk gain\` / \`rtk gain --history\` — token savings, overall and per command.
- \`rtk proxy <cmd>\` — run a command unfiltered, still tracked.
- \`RTK_DISABLED=1 <cmd>\` — skip RTK for one command.
- \`rtk discover\` — find past commands RTK could have condensed.`;

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
