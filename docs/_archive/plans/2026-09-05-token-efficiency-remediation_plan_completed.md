# Token efficiency remediation implementation plan

Status: implemented and verified; independent fresh completion review PASS. Live rollout checks remain explicitly deferred. Untracked and uncommitted.
Spec: [approved scope](2026-09-05-token-efficiency-remediation_spec_completed.md).
Live rollout: [remaining checks](2026-09-05-token-efficiency-remediation_livetest.md).
Original evidence: [usage audit](../audits/2026-09-05-astra-token-efficiency-audit.md).

## 1. Implemented changes

| Area | Result | Practical limit |
| --- | --- | --- |
| Codex consumption | Account for cumulative internal calls, cached input and reasoning without counting subsets twice. Preserve failed, interrupted, idle and child spend. | Subscription quota remains provider-reported. Dollar figures are Standard API equivalents. |
| Memory delivery | Budget advisory sources independently, retain supplied governing instructions and permissions, remove exact duplicate instruction strings, and remove the destructive second Codex prompt cap. | Restoring complete instructions can increase delivered text compared with the broken cap. |
| Browser tools | Codex can use six direct core tools plus search, describe and validated execute. Initial public schema JSON falls from 42 tools / 43,923 bytes to nine / 7,479 bytes. | This 83% initial schema reduction is not a measured reduction in total tokens or quota. Search results add context when requested. |
| Shell output | RTK guidance prefers supported compressed commands, preserves full local evidence and actual failures, and avoids unnecessary repeated reads. | Required full-file investigation and independent review remain in force. |
| Cost controls | Session budget alerts are independently deduplicated; session totals include cache tokens. Astra has an explicit offline price instead of unknown-model fallback pricing. | No new automatic task-tree governor, aggressive compaction or model/effort routing was enabled. |

## 2. Acceptance checklist

- [x] Read the accounting adapters, types, persistence callers and relevant tests; reproduce the multicall discrepancy.
- [x] Wire cumulative accounting, disjoint cache/reasoning buckets, partial persistence and root/child isolation through the actual runtime.
- [x] Cover duplicates, counter resets, sparse and resumed baselines, fallback, errors, interruptions, idle increments and child native turns spanning root turns.
- [x] Reproduce lost middle memory; apply deterministic budgets and verify manifest sizes/hashes against adapter-bound excerpts.
- [x] Preserve complete governing instructions, style and permissions; verify native continuation does not repeat startup content.
- [x] Verify stable browser discovery and invocation, original authenticated argument/policy dispatch, eager fallback and truthful attribution.
- [x] Inspect existing cost controls; repair independent session alerts without enabling gross-token compaction or changing selected models.
- [x] Run targeted tests and all canonical project checks.
- [x] Obtain the final fresh completion verdict with no unresolved actionable findings (fourth fresh review: PASS).
- [x] Record checks that require a restarted application, new provider session or real model work in the linked livetest document.
- [x] Generate and structurally verify the interactive review artifact, preserving its template runtime.

## 3. Verification

| Check | Result |
| --- | --- |
| Main TypeScript check | Passed |
| Spec TypeScript check | Passed |
| Full lint | Passed |
| TypeScript LOC ratchet | Passed |
| Main build, asset sync and preload bundle | Passed |
| Full unfiltered, unsharded suite | 1,974 files; 21,674 passed; zero failed; one existing platform skip; 317.2 seconds |
| Final accounting regressions | 110 passed, also present in the full run |
| Fourth independent reviewer | PASS; 220 focused tests, both typechecks, lint, LOC, independent final main build and native protocol smoke passed |
| Reviewer's accounting stress probe | 10,000 distinct child native turns; exact 1,200,000 tokens, including duplicate-event checks |
| Frozen source integrity | All 39 scoped source hashes unchanged through the final full run |

The full run used the existing official nvm Node 22.22.3 and the supported `AIO_TEST_MAX_FORKS=4` setting after host load cleared. Homebrew Node lacked the SEA fuse; official Node also built and started the standalone aio-mcp executable successfully. No dependency, lockfile, test-harness, compiler or lint configuration was changed. Clean installation was omitted to preserve the shared dirty checkout.

An earlier suite overlapped review fixes and was excluded as mixed-version evidence. The final frozen run is the completion evidence. The unrelated loop-coordinator LOC regression was resolved by its concurrent owner; this task did not modify that file. An existing settings-store test was aligned with the concurrent S1.5 metadata change by retaining exact assertions for seven visible and six hidden settings; no production settings behavior was changed here.

## 4. Implementation details and limits

Codex advisory reservations total 13,600 characters across observations, project brief, lessons, repository context, wake context and MCP guidance; other providers receive 20,400. Oversized sources become explicitly incomplete JSON-quoted excerpts, with source delimiters escaped. Governing instructions, style and permissions are outside these advisory limits. The manifest describes exactly the supplied blocks; provider retention is not assumed.

Accounting retains per-thread amounts, per-native-turn baselines and completion identities across root delivery drains. Known distinct native turns reset last-only fingerprints after duplicate guards. Missing resumed baselines and unknown child model/tier remain estimated. Effective tier is retained when reported, but flat pricing does not model Fast or long-context premiums. Astra's offline Standard rates are $10 per million uncached input and $50 per million output; cache pricing uses the shared pricing path. Source checked 2026-09-05: https://developers.openai.com/api/docs/models/gpt-6-astra.

The browser surface preserves direct screenshot image content, original public handlers, authenticated parent RPC validation and policy refusals. Deferral disabled means eager; Cursor remains eager. Installed Codex 0.153.4 and the actual built SEA executable successfully performed discovery, search, describe and execute against a controlled refusal responder without inference, credentials or browser control. Real model selection and Windows browser behavior await the updated running application.

No selected model, reasoning effort or live context-policy setting was changed by this task. Medium-versus-High quality/spend comparisons and automatic routing/governor ideas remain measured rollout experiments. No percentage of subscription savings is promised. Existing provider processes need replacement with new sessions to receive changed tools and startup prompts.

## 5. Evidence

- `_scratch/test-run.token-efficiency-frozen.log` and `_scratch/test-results.token-efficiency-frozen.json`: definitive full-suite result.
- `_scratch/2026-09-05-token-efficiency-canonical-gates.md`: command/exit ledger.
- `_scratch/token-efficiency-final-loc.log`: passing final LOC gate.
- `_scratch/token-efficiency-review4-build.log`: independent final main build.
- `_scratch/2026-09-05-efficiency-review-4.md`: final fresh PASS, all acceptance criteria mapped, no unresolved actionable findings.
- `_scratch/test-run.pid-32259.log`: final focused accounting cases.
- `_scratch/test-run.pid-72275.log` and `_scratch/test-run.pid-9229.log`: fourth reviewer's 220 tests.
- `_scratch/2026-09-05-stable-browser-built-protocol.log`: real installed client and executable proof.
- `_scratch/2026-09-05-browser-schema-size.json`: deterministic initial payload measurement.
- `_scratch/2026-09-05-token-efficiency-review-files.json`, `-review.patch` and `-source-hashes.json`: scoped final sources and frozen diff evidence.
- `_scratch/2026-09-05-efficiency-review-1.md`, `-2.md`, `-3.md`: earlier fresh failures, repaired with explicit regressions; excluded from final approval.

Implementation remains local and uncommitted. Active rollout checks remain separately discoverable in the livetest file.
