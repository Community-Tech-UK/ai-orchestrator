# Antigravity Binding Quota Summary Design

## Status

Approved for implementation on 2026-07-14. James confirmed that the compact
`AG` value should report the binding Gemini quota constraint rather than always
reporting the Gemini five-hour window.

Completed on 2026-07-15. The implementation and all agent-runnable verification
gates pass. The rebuilt-app observation remains correctly deferred to the
sibling `_livetest.md` document.

## Problem

The Antigravity snapshot exposes separate five-hour and weekly windows for the
Gemini model family. The compact quota strip currently hard-codes
`antigravity.gemini-5h` as the summary window. After that window resets, the
strip can display `AG 0%` while the Gemini weekly window is fully consumed.
The detail popover is numerically correct, but the headline is misleading.

## Design

Keep Gemini as Antigravity's headline model family. Treat both
`antigravity.gemini-5h` and `antigravity.gemini-weekly` as preferred summary
windows, and display whichever has the higher used percentage. If neither
preferred window is present, retain the existing fallback that selects the
most-used valid window in the snapshot.

Claude/GPT windows remain visible in the detail popover but do not replace the
Gemini headline because they represent a separate model-family quota pool.

## Scope

- Change only compact summary-window selection.
- Preserve quota collection, normalization, colours, reset text, and detail
  rows.
- Update the focused component regression test to cover a reset five-hour
  window alongside an exhausted weekly window.
- Do not alter unrelated dirty-tree work.

## Verification

- Observe the focused regression test fail against the current selector.
- Implement the minimal selector change and rerun the focused test.
- Run the canonical TypeScript, lint, LOC, and quiet-test gates.
- Record any packaged-app restart requirement in a sibling `_livetest.md`
  document rather than claiming live verification.
