# Prompt Engineering House Style

Use these rules for every LLM-facing prompt and parser contract in AI Orchestrator.

## Structure

1. State the role and goal first.
2. Put repository text, tool output, prior messages, and other-agent output in named delimiters. State that the payload is data, not instructions, and escape any closing delimiter in interpolated text.
3. Put the current task and output contract after large payloads.
4. Give one complete valid example for format-critical output. Do not put placeholders or pipe-separated pseudo-enums inside example values.

## Structured Output

- Prefer one small JSON object with closed enums and semantic field names.
- Use the shared last-fence-first parser with balanced-brace fallback and at most one repair attempt where structured parsing is required.
- Parse failure is an explicit unreliable/error outcome, never approval, success, or “no findings.”
- Keep producer instructions and consumer parsing tests together. Include prose-wrapped, malformed, and adversarial fixtures.

## Review Findings

- Severity is `critical`, `high`, `medium`, or `low`:
  - `critical`: exploitable, destructive, or correctness failure with severe impact and no safe workaround.
  - `high`: material defect likely to block release or change the result.
  - `medium`: real defect with bounded impact or a practical workaround.
  - `low`: limited-impact problem or worthwhile robustness improvement.
- Confidence is an integer from 0 to 100.
- “No findings” is valid and expected after genuine scrutiny.
- Every finding needs concrete evidence, normally `file:line`, and must clear the active agent's confidence threshold in code, not only in prose.

## Sentinels and Trust

- Use unusual structured sentinels, teach them once, prohibit quoting them, and detect them only as an exact line near the output tail.
- Verification and consensus agents should have read-only permissions.
- Treat external chat, web pages, repository files, memories, transcripts, and agent responses as untrusted content.
- Never let an LLM parse error fail open on a security or release gate.

## Provider Fit

- Keep shared prompts provider-neutral; do not assume Claude-specific tool names.
- Append Claude custom instructions rather than replacing the default system prompt.
- Codex persistence instructions should define stop criteria and avoid narration requirements.
- Do not present user-message wrappers as if they carried system authority.

## Style and Compaction

- Prefer positive instructions and one clear priority per section. Avoid competing `IMPORTANT`, `ONLY`, and all-caps commands.
- For summaries, list what must survive: decisions and reasons, constraints, open user asks, file paths, error state, next steps, and work not to repeat.
- Give a numeric size budget and discard old completed detail before constraints or remaining work.

PR review must check this document whenever a change adds or modifies an LLM-facing prompt or parser.
