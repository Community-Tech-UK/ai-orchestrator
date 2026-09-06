# History Preview Missing Opening Prompt Implementation Plan

## Status

Completed. Implements the linked [specification](../specs/2026-08-27-history-preview-missing-opening-prompt_spec_completed.md).

## Root Cause

The native Claude transcript still contains the opening user prompt, but the app-owned archive is a bounded stream window containing subagent events that do not exist in the root transcript. The existing strict-tail repair therefore rejects it. Separately, the history preview gives `OutputStreamComponent` a synthetic instance ID without overriding its live-storage pagination probe.

## Implementation

1. Extend `HistoryManager.repairArchiveFromNativeTranscript` with a narrowly scoped repair case for an existing Claude entry whose matched native opening prompt is absent from all archived user messages.
   - Preserve the existing legacy-redaction and strict-tail paths.
   - Back up the original archive with a missing-opening-prompt-specific suffix.
   - Replace messages and refresh transcript-derived metadata while preserving app-owned entry identity and metadata.
   - Leave archives containing the native opening prompt untouched.
2. Add a history-preview-specific older-message probe in `InstanceDetailComponent` and bind it in the preview template.
   - Return `hasMore: false` because history IPC already supplies the complete archive.
   - Report the preview message count and avoid the synthetic-ID live-storage query.
3. Rebuild and exercise the repair against an isolated copy of the affected archive and native transcript, then verify the rendered preview behaviour before updating tests.
4. Add focused regressions for the missing-prompt repair, backup/metadata refresh, healthy-archive preservation, and preview probe wiring.
5. Run targeted verification followed by the canonical TypeScript, lint, line-count, main-build, and full-test gates.
6. Obtain a fresh independent `task-completion-gate` review. Resolve every actionable finding and repeat until `VERDICT: PASS`.

## Risk and Coverage

- **False-positive archive replacement:** repair requires an existing app-owned entry matched by provider session ID plus absence of the normalized native opening prompt. A healthy non-tail archive regression protects this boundary.
- **Metadata loss:** the repair reuses the existing metadata-spread path; focused assertions cover identity preservation and transcript-derived fields.
- **Preview regression:** only the archived-history preview gets the custom probe, leaving live instance, side-chat, restore, and fork behaviour unchanged.

## Verification Commands

```bash
npm run test:quiet -- src/main/history/__tests__/history-manager-native-import.spec.ts
npm run test:quiet -- src/renderer/app/features/instance-detail/instance-detail-history-preview-restore.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

## As-Built Notes

- Added a dedicated native-Claude archive repair classifier for legacy-redacted output, strict transcript tails, and archives missing the normalized native opening prompt.
- Reused the repository's canonical history-provider inference in both importer lookups. This preserves provider-less legacy Claude repair while excluding explicit non-Claude collisions, including adversarial index ordering.
- The repair creates a one-time `.missing-opening-prompt-backup`, replaces messages with the authoritative native root transcript, refreshes transcript-derived metadata, and preserves app-owned identity fields.
- History previews now provide their own no-older-page probe and disable live prompt-index retrieval, so synthetic `history-preview:*` IDs never reach live output storage. Live instances retain the existing default behaviour.
- Regression coverage includes all three existing/new repair classifications, healthy normalized-prompt preservation, explicit non-Claude collision safety, provider-less legacy Claude repair, synthetic pagination suppression, and synthetic prompt-index suppression.
- Isolated Electron verification rendered the recovered opening prompt with no misleading earlier-message control. Evidence: `output/playwright/history-preview-fix/recovered-opening-prompt.png`.
- The real archive `e9f09e45-986b-4dd3-b4b1-ae8c225a26ae` was repaired from its exact native transcript. It now contains 681 messages beginning with `Can you please continue working through all the livestests you can.`; the previous 1,000-message archive remains recoverable at the `.missing-opening-prompt-backup` path. The live index and original instance identity were verified after repair.
- Final verification passed: focused specs (2 files, 17 tests), renderer and spec TypeScript checks, lint, TypeScript LOC ratchet, Electron main/preload build, full suite (1,804 files, 19,191 tests), and `git diff --check`.
- A genuinely fresh `task-completion-gate` review returned `VERDICT: PASS` with no unresolved findings after four earlier reviews identified and drove fixes for synthetic prompt-index access and provider-ownership edge cases.
