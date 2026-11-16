# Prompt Engineering House Style

Use these rules for every LLM-facing prompt and parser contract in AI Orchestrator.

## Authoring Rules

Every prompt is paid for on every turn it rides in. Write and change prompts by these seven rules.

1. **The delete test.** Before keeping a sentence, ask what the model would do wrong without it. If the answer is "nothing", delete it.
2. **Rules over reasons.** Say what to do. Keep a reason only when the model would get an edge case wrong without it.
3. **Structure beats prose.** Use a short list, a table or a closed example in place of a paragraph the model must parse.
4. **One source of truth.** State a rule in one place and build every prompt that needs it from that place. A rule copied into a second prompt or bullet will drift, and both copies cost tokens.
5. **No sediment.** When behaviour changes, rewrite the prompt as if the new behaviour had always been the plan. Do not append "also", "note that" or a patch beside the old wording.
6. **Measure before and after.** Every prompt surface has a size ceiling in `src/main/context/prompt-budgets.spec.ts`. Lower the ceiling in the same change that cuts the prompt. A raise needs a reason comment beside the entry. Each injection also writes one debug line (surface, characters, session; `src/main/logging/prompt-injection-log.ts`), so a size seen in the log can be matched to its ceiling.
7. **Each added line names the failure it prevents.** Put that failure in the commit or the nearby comment, and remove the line when the failure becomes impossible.

First example of rule 4: the Plan Queue's autonomy rules live in `autonomyRules()` in `src/main/plan-queue/plan-queue-prompts.ts` and are not restated in the livetest worker's own bullets.

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
  - Exception: a notice delivered only to a Claude session may name Claude tooling. The stopped-helper carry-on notice names `SendMessage` and the Agent call id because resume was proven on Claude only (experiment record in `docs/plans/2026-11-12-usage-burn-followups_history.md`). Keep the wording in a shared module with unit tests and state the exception's scope where the wording is defined (`src/main/session/stopped-helper-resume-notice.ts`).
- Append Claude custom instructions rather than replacing the default system prompt.
- Codex persistence instructions should define stop criteria and avoid narration requirements.
- Do not present user-message wrappers as if they carried system authority.

## Carry-On Notices

- A resume or recovery carry-on notice is one model-facing `[System: ...]` block: what happened, what to do instead of redoing work, and one fallback path.
- The user-facing line stays short and concrete: what stopped and that the session was told to carry it on. Instructions live in the model text, never in the user line.
- Deliver the notice as a single queued string, joined with any replay preamble before queueing, so a later queue call cannot replace it.

## Style and Compaction

- Prefer positive instructions and one clear priority per section. Avoid competing `IMPORTANT`, `ONLY`, and all-caps commands.
- For summaries, list what must survive: decisions and reasons, constraints, open user asks, file paths, error state, next steps, and work not to repeat.
- Give a numeric size budget and discard old completed detail before constraints or remaining work.

PR review must check this document whenever a change adds or modifies an LLM-facing prompt or parser.
