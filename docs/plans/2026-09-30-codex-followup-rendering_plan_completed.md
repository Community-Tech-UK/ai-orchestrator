# Codex follow-up rendering

Status: implemented and verified. Session reported: `x215k2118`.

Goal: replace raw Codex follow-up directives with readable, keyboard-accessible controls that copy their prompts. Stored transcript content remains intact.

## As built

- A Marked inline extension handles single/double-colon follow-up directives and emits escaped labels and JSON prompt attributes through the existing DOMPurify sanitizer.
- Complete directives are protected during whole-document cleanup. Numeric placeholder nonces are selected with one scan; prompt JSON preserves orchestration markers, CRLF, NUL, escapes and lone surrogates.
- Marker positions are scanned once per inline token-array context. Weak maps retain offsets rather than transcript strings, and keep nested parsing contexts independent.
- The output-stream delegated click handler calls the existing ClipboardService and records success/failure feedback. It does not submit a turn or modify drafts.
- Native buttons use existing theme tokens and keyboard focus styling. Table cells render inline tokens. Code examples and invalid/incomplete directives remain readable; Markdown links retain their existing literal label path.
- Work stayed in the supplied checkout. Unrelated staged/unstaged work was preserved. No dependency/config/suppression changes, commits, branches or worktrees were created.

## Completed checklist

- [x] Reproduce the screenshot through the production MarkdownService on windows-pc.
- [x] Implement parsing, styling and delegated clipboard behavior.
- [x] Verify browser behavior before adding the initial regression coverage.
- [x] Cover exact payloads, sanitization, code/invalid/streaming forms, tables, delegation and teardown.
- [x] Reproduce and resolve all review findings, including both scanning performance issues.
- [x] Pass focused tests and every canonical verification command.
- [x] Obtain a genuinely fresh independent completion-gate PASS.
- [x] Record as-built evidence, stop temporary fixture servers and close this plan.

## Final verification

Evidence directory: `_scratch/codex-followup/`.

| Check | Result |
| --- | --- |
| Focused renderer tests | 2 files, 51 tests pass; `_scratch/test-run.pid-95123.log` |
| `npx tsc --noEmit` | Exit 0 |
| `npm run typecheck:spec` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npm run check:ts-max-loc` | Exit 0 |
| `npm run build:main` | Exit 0 |
| `npm run build:renderer` | Exit 0 |
| `npm run test:quiet` | Exit 0; 2,260 files, 27,017 passing tests, six existing skips |

Command statuses and log paths: `verification-pass4.json`. Full suite summary: `suite-pass4.log`; raw output: `_scratch/test-run.pid-2528.log`; structured results: `_scratch/test-results.pid-2528.json`. The documented test fan-out override was `AIO_TEST_MAX_FORKS=4`.

Windows Browser Gateway fixture showed three correctly named native buttons. All three original prompt payloads were checked through its clipboard adapter across the in-loop checks. The final independent reviewer verified the HR prompt on the rebuilt fixture (`?fixed=5`), click audit `c6ba6ea6-8b76-472b-af1d-76c587b1707d`, read-back audit `de5d983d-41d8-40ba-b40d-a42941190e12`. This verifies production MarkdownService/styles and the adapter boundary; it does not claim OS clipboard or running packaged-app verification. Screenshot capture timed out; DOM, accessibility snapshots and read-back succeeded. The running app was not restarted.

## Fresh review and remediation evidence

Earlier FAIL reviews exposed prompt cleanup/attribute normalization, table token bypass, quadratic placeholder collision selection and quadratic inline start lookahead. Every actionable finding was reproduced and corrected before a new fresh review. RED tests are retained in `_scratch/test-run.pid-32953.log`, `_scratch/test-run.pid-98896.log`, `_scratch/test-run.pid-25851.log` and `_scratch/test-run.pid-86313.log`. Superseded runs remain retained; pass2's full suite was deliberately interrupted (exit 130), never counted as green.

Final independent verdict: **PASS**, no unresolved actionable findings. Report: `pass4-independent-verdict.txt`; forensic/source hashes: `pass4-independent-forensics.json`; independently inspected suite evidence: `pass4-independent-suite-evidence.json`. The reviewer reran focused tests, typecheck, lint and LOC; confirmed all canonical results; read the actual full suite log; and verified source hashes remained unchanged after the run.

The reviewer compared 400 paired parsing contexts against a straightforward scanner, with byte-identical output. Independent scan work was 112k characters for 96k formatted input, and 1x for repeated colons. Root performance probes: `inline-start-perf-fixed.json` and `collision-perf-fixed.json`. No unresolved verification or implementation items remain.
