# Mobile Provider Continue Action Specification

**Status:** Completed and verified on 2026-07-26.

**Implementation plan:** [2026-07-26-mobile-provider-continue_plan_completed.md](../plans/2026-07-26-mobile-provider-continue_plan_completed.md)

## Problem

On the mobile New session screen, selecting a provider updates the checked provider but leaves the Session settings sheet open. That sheet has no explicit completion action. The only obvious route back to the composer is opening Model and selecting a model, even when the already resolved/default model is correct.

## Root Cause

`selectProvider()` updates provider/model/reasoning state but intentionally keeps Session settings open so model and reasoning remain customizable. The Session settings template has no header action, while the model-selection path closes Session settings before opening its own sheet. Choosing a model then closes that second sheet, accidentally becoming the apparent Continue action.

## Required Behavior

- Show a checkmark action in the Session settings header.
- Give it the accessible label `Continue with selected provider`.
- Keep the action available for Auto and explicit providers.
- Activating it closes Session settings and returns to the New session composer.
- Preserve the currently selected provider, model/default model, and reasoning effort.
- Provide the existing tap haptic.
- Keep Model available for users who want to customize it.
- Do not change gateway calls, creation payloads, persistence, or provider-selection behavior.

## Design

Use the existing mobile icon-button language: a standard `--control-size` circular button with the shared check icon, aligned to the right of the Session settings heading. The heading copy remains unchanged. This is lighter than a sticky bottom button and avoids auto-closing before optional model customization.

## Verification

- Reproduce the current dead-end at a 390×844 mobile viewport.
- After implementation, verify selecting a provider and pressing the check action returns to the composer without opening Model.
- Verify the chosen provider remains displayed after continuing.
- Add a regression test for the accessible action and its close behavior only after the real UI path passes.
- Run mobile tests, typecheck, lint, build, repository canonical gates, and the independent completion gate.

## As Built

- Added an accessible check action to the Session settings header using the existing mobile icon-button and check icon.
- Added `completeSettings()`, which closes only Session settings and triggers the normal tap haptic without changing provider, model, reasoning, gateway, payload, or persistence behavior.
- Added a component regression test that proves the settings sheet closes, the model sheet remains closed, Codex remains selected, and the two expected tap haptics fire.
- Verified the flow twice at 390×844: select Codex, keep Model available and unchanged, activate Continue, return to the composer, and retain Codex as the execution target.
- Passed the focused and full mobile checks, production build, repository typechecks/lint/LOC ratchet, a 15,909-test canonical aggregate, and an independent completion gate with `VERDICT: PASS`.
