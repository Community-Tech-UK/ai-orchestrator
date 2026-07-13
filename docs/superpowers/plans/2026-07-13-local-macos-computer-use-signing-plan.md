# Local macOS Computer Use Signing Fix Implementation Plan

> **For agentic workers:** Execute inline with test-first red/green cycles. Do not commit or push without James's explicit authorization.

**Goal:** Ensure `npm run localbuild` signs Harness and its Swift desktop helper with the same real Apple code-signing identity so macOS Accessibility grants apply to the process that calls `AXIsProcessTrusted()`.

**Architecture:** Keep the existing helper protocol and packaged path. Replace the local build's forced ad-hoc signature with a local-only custom electron-builder signer that selects an installed Apple Development or Developer ID identity, signs the complete app tree, and verifies that Harness and `desktop-helper` have the same non-empty Team ID. Stable release builds retain their existing Developer ID flow and gain an explicit helper-identity verification step.

**Tech Stack:** Node.js CommonJS build scripts, electron-builder 26, `@electron/osx-sign`, macOS `security`/`codesign`, Vitest.

## Global Constraints

- Do not change the desktop-helper JSON protocol or runtime path.
- Do not hard-code James's certificate name, hash, or Team ID.
- Fail local macOS packaging clearly when no real code-signing identity is installed.
- Preserve the explicitly documented unsigned packaging command for diagnostics, while documenting that unsigned builds cannot provide stable Computer Use TCC behavior.
- Do not reset or mutate TCC during automated verification.

---

### Task 1: Select and apply a real local signing identity

**Files:**
- Create: `scripts/sign-local-macos.js`
- Create: `scripts/__tests__/sign-local-macos.spec.ts`
- Modify: `scripts/localbuild.js`
- Modify: `scripts/__tests__/localbuild.spec.ts`

- [ ] Write failing tests for identity parsing/priority, missing-identity failure, custom signer forwarding, and localbuild arguments.
- [ ] Run the two targeted specs and confirm failure is caused by the absent signer and old `identity=null` argument.
- [ ] Implement the local signer using injected seams for unit tests and `@electron/osx-sign` in production.
- [ ] Point local macOS builds at the custom signer and disable notarization without disabling signing.
- [ ] Re-run the targeted specs.

### Task 2: Verify the helper ownership boundary

**Files:**
- Create: `scripts/verify-macos-helper-identity.js`
- Create: `scripts/__tests__/verify-macos-helper-identity.spec.ts`
- Modify: `scripts/sign-local-macos.js`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/packaging-native-modules.md`

- [ ] Write failing verifier tests for matching teams, missing Team IDs, mismatch, and missing helper.
- [ ] Implement codesign metadata parsing and app/helper Team ID comparison.
- [ ] Invoke verification after the local custom signing operation and in the signed release workflow.
- [ ] Document signed localbuild behavior and the unsigned diagnostic limitation.
- [ ] Run targeted script and release-workflow specs.

### Task 3: Package and verify

- [ ] Run the custom signer specs, localbuild specs, helper build specs, and release workflow specs.
- [ ] Produce a signed arm64 directory build using the local signer.
- [ ] Verify Harness and `desktop-helper` share a non-empty Team ID and `codesign --deep --strict` passes.
- [ ] Run `npx tsc --noEmit`, spec typecheck, lint, LOC ratchet, and the full quiet suite.
- [ ] Record any remaining clean-TCC/relaunch-only validation in the existing Computer Use livetest document; rename this plan `_completed.md` only after all agent-runnable checks pass.
