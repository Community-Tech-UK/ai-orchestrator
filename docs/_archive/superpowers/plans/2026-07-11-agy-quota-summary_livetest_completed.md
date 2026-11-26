# AGY Quota Summary Live Test

Prerequisite: quit the currently running `/Applications/Harness.app`. The app
must be restarted because provider quota probes execute in Electron's main
process and cannot hot-reload. This check validates the locally packaged build
created from the completed [AGY quota summary design](../specs/2026-07-11-agy-quota-summary-design_completed.md).

## Install and restart

1. Quit Harness completely.
2. Replace `/Applications/Harness.app` with
   `/Users/suas/work/orchestrat0r/ai-orchestrator/release/mac-arm64/Harness.app`,
   or install
   `/Users/suas/work/orchestrat0r/ai-orchestrator/release/Harness-0.1.0-arm64.dmg`.
3. Launch Harness again.

Expected result: Harness starts normally and existing local application data is
preserved.

Why deferred: replacing/restarting the application that hosts the current task
would terminate this task before it could report its verification evidence.

## Verify quota UI

1. Open the provider quota popover.
2. Press **Refresh** beside Antigravity.
3. Confirm the obsolete `Pro daily`, `Flash-lite daily`, and `Flash daily`
   windows are absent.
4. Confirm Antigravity shows these windows:
   - `Gemini · 5-hour`
   - `Gemini · weekly`
   - `Claude/GPT · 5-hour`
   - `Claude/GPT · weekly`
5. Confirm the compact `AG` percentage matches the Gemini five-hour value shown
   by the standalone token-usage monitor, allowing for usage changes between
   refreshes.

Expected result: both applications report the same current AGY quota contract;
the compact percentage is driven by Gemini's five-hour bucket.

Why deferred: the installed app bundle at the start of this task was packaged
before the source fix and contains the legacy endpoint. The new package has
been built and smoke-tested, but its main-process UI path requires an actual
restart to observe.

## Evidence run — 2026-07-12

**Status: PARTIAL (install/restart prerequisite confirmed; quota UI check still pending).**

- `/Applications/Harness.app` was running as version `0.1.0`.
- Its `app.asar` SHA-256 matched `release/mac-arm64/Harness.app` exactly, confirming the built
  package described above was the installed package.
- Deep strict `codesign` verification passed for both installed and release app bundles.

The Harness UI cannot be controlled from this verifier, and no provider-quota refresh/result
record was present in the app logs. The obsolete-window absence, four expected window labels,
and compact `AG` percentage comparison remain unverified.

## Completion evidence — 2026-07-12

**Status: PASSED.** The freshly rebuilt packaged app was launched directly after the installed
bundle had been stopped, preserving the existing Harness application data. A live Antigravity
refresh showed exactly the four expected windows: Gemini 5-hour, Gemini weekly, Claude/GPT
5-hour, and Claude/GPT weekly. None of the obsolete Pro/Flash daily labels was present.

The live response reported Gemini five-hour usage at 10.9% and the compact chip displayed
`AG11%`. The standalone token-usage monitor independently reported `gemini · 5h` at 10.9% at
the same time. This run also exposed and fixed a real summary-selection bug that had previously
shown the 81% weekly value; the rebuilt packaged rerun confirmed the compact chip now selects
the Gemini five-hour window.
