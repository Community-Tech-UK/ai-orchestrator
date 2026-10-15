# macOS Computer Use focus recovery

Date: 2026-09-25  
Status: complete; implementation, live smoke test, repository gates, and independent completion
review passed.

## Root cause

The multi-display coordinate offsets were not the failing boundary. Native probes showed that
Chrome's AX and CG window frames agreed, including global coordinates, and that input succeeds when
activation, observation, and input run atomically.

The reproducible cross-call failure was focus ownership: `activate_window` verified Chrome while its
short-lived Swift helper was alive, but Harness reclaimed foreground focus when the tool result was
rendered. The later input helper therefore correctly rejected Chrome as inactive. The old helper also
treated the first Quartz window-list entry as keyboard focus, which is not a reliable focus oracle for
multi-window apps across Spaces and displays.

## Implemented behavior

- The Swift helper resolves the actual focused window through `kAXFocusedWindowAttribute` and maps it
  back to the visible CG window by frame, with title disambiguation and fail-closed ambiguity handling.
- Explicit `activate_window` uses AppKit's inter-app activation option and explicitly focuses the AX
  window.
- A successful activation creates a one-shot gateway lease valid for less than 15 seconds, bound to
  the exact instance, provider, canonical app, and observed window. It is expired at 15,000 ms.
- Input may use that lease only when the helper's own parent Harness process reclaimed focus. Focus on
  WhatsApp or any other unrelated process still fails closed. External IPC/MCP callers cannot set the
  internal recovery flag because their schemas remain strict.
- The helper protocol was bumped from 1.2.0 to 1.3.0 so mismatched packaged binaries fail closed.

## Verification evidence

- Regression test demonstrated red before implementation, then green.
- Focused suite: 84 tests passed across the gateway service, Darwin driver/client, and helper build.
- The Swift helper compiled successfully as the production binary.
- Real Mac, real Chrome window `44332`: activation, a separate fresh accessibility snapshot/query,
  and a third separate click call succeeded. This is the exact pattern that previously returned
  `computer_use_target_not_active`.
- `npx tsc --noEmit`, `npm run typecheck:spec`, and `npm run check:ts-max-loc` pass. The focus-recovery
  state was extracted into its own module to keep the input controller below the 700-line ceiling.
- `npm run lint`, `npm run build:main`, and `npm run build:renderer` pass.
- The full quiet suite passed: 2,226 files and 26,529 tests.
- Independent review found and drove two boundary corrections before acceptance: provider isolation
  for otherwise identical sessions, and inclusive expiry at exactly 15,000 ms. Both have regression
  coverage. A final fresh reviewer returned `VERDICT: PASS` with no unresolved findings.

## Workspace safety

No branch or worktree was created. Existing unrelated documentation changes were not modified by this
task. Nothing has been committed or pushed.
