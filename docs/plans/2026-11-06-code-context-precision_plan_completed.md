# Code context precision and Linux packaging

Status: implemented and verified on 6 November 2026. James approved fixing both that day after the live checks. This fixes [LT-725](livetest-remediation-register.md#lt-725) and [LT-726](livetest-remediation-register.md#lt-726). Their live checks are deferred to the [live-test document](2026-11-06-search-and-memory-repair_plan_livetest.md) and have not been run.

## Why

Live check 3 of the [search and memory repair](2026-11-06-search-and-memory-repair_plan_completed.md) failed: most code added to real messages was unrelated. Check 9 found that a Linux package could not finish building.

## How it was measured

- 1,071 real messages from Claude session transcripts over 14 days, in indexed workspaces. 578 were 300 characters or shorter, which is the length the app searches whole.
- Independent agents labelled message and code pairs blind, without knowing which rule produced them.
- The rule was tuned on 165 short messages, then scored on the other 413. The everyday word list came from the tuning errors.
- The commit-description sets from the earlier work measured what stricter matching costs.
- The scoring harness approximates the shipped rule, which was then measured directly. The raw figures are in `_scratch/search-repair-evidence/context-evidence-numbers.log` and `context-precision-final.log`.

## Findings

- On short messages the shipped rule added code to 75%, and about 7% of its top results were relevant.
- Text over 300 characters is cut down to a fragment before searching. With the old rule on whole long text, about 5% of matches were relevant. Fragments were not measured separately, so automatic context now skips them.
- Words in a chunk's body prove little. Words in its file path or symbol name are the useful signal.
- The embedding model does not help: it separated relevant from unrelated with an AUC of 0.62, where 0.5 is chance.
- No keyword rule tried reached the 80% that LT-725 first asked for. That target was set before any labels existed.
- 610 of 1,425 searches repeated a location in their top 5. The chunker writes some nested spans more than once: 83,263 locations have more than one row, with identical text in the cases checked.

## What changed

- `isStrongMatch` needs a source file named after two informative words of the message, in its path or symbol name, or the chunk that defines a code name from the message. It ignores test, document and data files, unknown file types, and folders of copies, output and third-party code.
- `CodeRetrievalService.search` returns nothing for automatic callers when the text had to be cut down. That covers message context, first prompts, fast-path tasks and loop goals.
- Everyday words no longer count towards a match. This applies to automatic context only.
- `searchHydratedChunks` shows a location once, in ordinary searches too. Repeats have identical text, so nothing is lost.
- `scripts/set-electron-fuses.js` finds the Linux binary by the name electron-builder gave it.

## Results

| Measure | Before | After |
|---|---|---|
| Short real messages given code | 75% | 12% |
| Text over 300 characters given code | every fragment that matched | none |
| Top result relevant, short messages not used for tuning | about 7% (3 of 44) | 52% (28 of 54) |
| Second result relevant, same messages | not measured | 62% (23 of 37) |
| Automatic searches repeating a location | common | 0 of 1,071 |
| Ordinary search, right file in top 10 | 69.0%, 60.2% | 69.0%, 60.2% |
| Automatic context, right file in top 3 | 53.3%, 47.1% | 48.2%, 37.9% |

Short messages getting unrelated code as their top result fall from about 70% to about 6%. The cost is that automatic context stays quiet on 25% to 30% of commit descriptions.

## Known limits

- About half of the top results added are still unrelated. Automated `[System: Account switched…]` notices are one repeated cause.
- Loop goals and first prompts over 300 characters get no automatic code.
- A code name in a message counts only when a chunk is defined by exactly that name. Its parts do not count towards the two words, so `getEmbeddingService` alone does not match `embedding-service.ts`.
- The 52% has a margin of about 13 points either way. Labels came from agents judging a short excerpt and told to answer no when unsure, so absolute figures are approximate. The second results were labelled in a separate pass.
- Word matching takes the first name word that fits, so `plan` and `planner` can miss `src/planner/plan.ts` in one order, which only loses a match. `plan` and `plans` can pass on `src/plan/planner.ts`. Both need a message using two forms of a word.
- The duplicate rows are still written, and they use up places in the 100-chunk candidate pool. Fixing the chunker needs a re-index and is separate work.
- `NON_SOURCE_FOLDER` is a judgement. It treats `out`, `build` and `target` as output only at the top of a project.

## Verification

- `tsc`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `check:ui-hints`, `verify:architecture`, `verify:exports`, `bench:retrieval`, `build:main` and `build:renderer` passed on the final code.
- The full suite passed: 39,374 tests in 3,103 files.
- A Linux package built in a clean container with the fix, and its fuses read back as set. An AppImage has not been built.
- Independent reviews ran after each round of changes, and the last one passed. The notes left open are the edge cases under Known limits.

Not verified: the rebuilt app. Live acceptance is check 3 in the [live-test document](2026-11-06-search-and-memory-repair_plan_livetest.md), and it needs a rebuild.
