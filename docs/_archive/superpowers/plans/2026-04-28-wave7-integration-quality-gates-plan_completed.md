# Wave 7: Final Integration & Quality Gates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the integration gate over Waves 1–6, fix any wiring drift, write runbooks, install audit scripts, and smoke-test the packaged DMG.

**Status:** Completed on 2026-04-29. Results are tracked in `docs/runbooks/wave-7-smoke-results.md`.

**Architecture:** Wave 7 is primarily a gate and documentation pass. Two minimal renderer integration fixes were required during final validation: the CLI update pill was mounted in the app shell, and provider runtime event subscription now no-ops in browser/dev renderer mode when preload APIs are unavailable.

**Tech Stack:** TypeScript 5.9, Node CLI scripts, Electron Builder for packaging.

**Spec:** [`docs/superpowers/specs/2026-04-28-wave7-integration-quality-gates-design_completed.md`](../specs/2026-04-28-wave7-integration-quality-gates-design_completed.md)
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md`](../specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`](./2026-04-28-cross-repo-usability-upgrades-plan_completed.md)

---

## How to read this plan

- Phases 1–3 are auditing: produce evidence first, fix gaps next.
- Phases 4–8 are documentation: runbooks per wave.
- Phase 9 is the final gate: full suite + DMG smoke.
- **Verification commands** (run after every code-change task):
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - targeted vitest spec(s) for the touched code
- **Critical rule (per `AGENTS.md`):** **NEVER run `git commit` without explicit user approval.** Every task below ends with a suggested commit message — run the commit only after the user approves. **Never push to remote** under any circumstances; pushing is always the user's call.
- **If a prior wave is missing or partial, STOP at Phase 1.** Open an issue, do not patch in Wave 7.

## Phase index

1. Phase 1 — Pre-flight: confirm Waves 1–6 shipped
2. Phase 2 — IPC audit matrix
3. Phase 3 — Schema/alias-sync audit script + integration
4. Phase 4 — Native-module ABI re-verification
4b. Phase 4.5 — Cross-wave integration smoke
5. Phase 5 — Runbooks (six docs)
6. Phase 6 — Screenshot pass against packaged DMG
7. Phase 7 — Memo cleanup
8. Phase 8 — Architecture doc reconciliation
9. Phase 9 — Full suite + DMG smoke + sign-off

## Completion evidence

- Automated gates, package build, Electron smoke, native ABI, IPC, exports, contracts, architecture inventory, and full tests are recorded in `docs/runbooks/wave-7-smoke-results.md`.
- Interactive UI checks were captured in isolated dev-renderer benchmark mode with screenshots and selector assertions under `docs/runbooks/screenshots/wave-7/`.
- Packaged validation used `npm run localbuild` and `npm run smoke:electron`; the completion pass intentionally did not install over or control any installed/running user app.
- The final validation fixes are covered by `src/renderer/app/core/services/__tests__/instance-events.service.spec.ts`, `src/renderer/app/features/title-bar/cli-update-pill.component.spec.ts`, and `src/renderer/app/core/state/__tests__/cli-update-pill.store.spec.ts`.

---

## Phase 1 — Pre-flight: confirm Waves 1–6 shipped

### Task 1.1: Walk the wave checklists

- [x] Open each wave's completed plan and confirm no shipped wave has remaining unchecked work:
  - `docs/superpowers/plans/2026-04-28-wave1-command-registry-and-overlay-plan_completed.md`
  - `docs/superpowers/plans/2026-04-28-wave2-navigation-pickers-prompt-recall-plan_completed.md`
  - `docs/superpowers/plans/2026-04-28-wave3-workflow-resume-history-recovery-plan_completed.md`
  - `docs/superpowers/plans/2026-04-28-wave4-output-clipboard-theme-terminal-plan_completed.md`
  - `docs/superpowers/plans/2026-04-28-wave5-orchestration-hud-verification-verdicts-plan_completed.md`
  - `docs/superpowers/plans/2026-04-28-wave6-doctor-diagnostics-updates-artifacts-plan_completed.md`
- [x] If any task is open, **STOP**. Document the gap in `docs/runbooks/wave-1-6-ipc-audit.md` (under "Outstanding") and notify the user.

### Task 1.2: Confirm code-level smoke

- [x] `git status` clean (no uncommitted changes from earlier waves left dangling).
- [x] `npx tsc --noEmit` passes.
- [x] `npx tsc --noEmit -p tsconfig.spec.json` passes.
- [x] `npm run lint` passes.

If anything fails, root-cause and fix inside the responsible wave's branch — not in Wave 7.

---

## Phase 2 — IPC audit matrix

### Task 2.1: Collect IPC handler registrations

- [x] Run `grep -RIn "ipcMain.handle" src/main/` and capture output.
- [x] Run `grep -RIn "ipcRenderer.invoke" src/preload/ src/renderer/` and capture output.
- [x] Build a per-channel matrix in `docs/runbooks/wave-1-6-ipc-audit.md`:

  ```markdown
  | Wave | Channel | Direction | Schema | Preload key | Domain | Renderer consumer |
  |---|---|---|---|---|---|---|
  | 1 | `command:resolve` | renderer→main | `CommandResolveRequestSchema` | `command.resolve` | `commandsDomain` | `command.store.ts:resolveCommand()` |
  | 1 | `command:list` | renderer→main | … | … | … | … |
  | 1 | `usage:track` | renderer→main | … | … | … | … |
  | 2 | `prompt-history:append` | renderer→main | … | … | … | … |
  | 3 | `workflow:can-transition` | renderer→main | … | … | … | … |
  | 5 | `verification:verdict-ready` | main→renderer | … | … | … | … |
  | 6 | `diagnostics:export` | renderer→main | … | … | … | … |
  ```

  Add every Wave 1–6 IPC channel.

### Task 2.2: Find drift

- [x] For each row, mark **Drift** if any column is empty:
  - Channel registered but no Zod schema → security/data-integrity risk.
  - Channel registered but not exposed via preload → renderer cannot invoke (dead code).
  - Channel exposed via preload but no consumer → unreferenced.
  - Channel consumed but no handler → runtime crash.
- [x] Open a follow-up issue per drift row in the issue tracker. Do not fix here unless the fix is one-line wiring.

### Task 2.3: One-line drift fixes (only)

- [x] For each one-line wiring fix, commit per fix with conventional message:
  ```
  fix(ipc): wire <channel> in <preload|domain>
  ```
- [x] Re-run grep matrix; confirm row populated.
- [x] If a fix would touch >5 lines, defer to wave-owner follow-up issue.

---

## Phase 3 — Schema/alias-sync audit script

### Task 3.1: Test (red)

- [x] Create `scripts/__tests__/check-contracts-aliases.spec.ts`:
  - Test detects missing alias in `tsconfig.json`.
  - Test detects missing alias in `tsconfig.electron.json`.
  - Test detects missing alias in `src/main/register-aliases.ts`.
  - Test detects missing alias in `vitest.config.ts`.
  - Test passes when all four are present.
  - Test ignores commented-out references (`// @contracts/schemas/foo`).
- [x] Run vitest; tests fail (red).

### Task 3.2: Implement script

- [x] Create `scripts/check-contracts-aliases.ts`:

  ```ts
  import { readFileSync, readdirSync, statSync } from 'node:fs';
  import { join } from 'node:path';

  const ROOT = process.cwd();
  const SCHEMAS_DIR = join(ROOT, 'packages/contracts/src/schemas');

  const REQUIRED_SYNC_POINTS = [
    'tsconfig.json',
    'tsconfig.electron.json',
    'src/main/register-aliases.ts',
    'vitest.config.ts',
  ];

  function discoverSubpaths(): string[] {
    return readdirSync(SCHEMAS_DIR)
      .filter((name) => name.endsWith('.schemas.ts'))
      .map((name) => name.replace('.schemas.ts', ''));
  }

  function stripComments(content: string): string {
    return content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  function main() {
    const subpaths = discoverSubpaths();
    const errors: string[] = [];

    for (const subpath of subpaths) {
      const expected = `@contracts/schemas/${subpath}`;
      for (const file of REQUIRED_SYNC_POINTS) {
        const raw = readFileSync(join(ROOT, file), 'utf8');
        const cleaned = stripComments(raw);
        if (!cleaned.includes(expected)) {
          errors.push(`Missing alias '${expected}' in '${file}'`);
        }
      }
    }

    if (errors.length > 0) {
      console.error('Contracts alias sync failed:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    console.log(`Contracts alias sync OK: ${subpaths.length} subpaths verified.`);
  }

  main();
  ```

- [x] Run vitest; tests pass (green).

### Task 3.3: Wire into prebuild (APPEND, do NOT replace)

The current `prebuild` script chains five guards: `check-node` → `verify-native-abi` → `generate:ipc` → `verify:ipc` → `verify:exports`. Wave 7 **APPENDS** the new alias-sync check to this chain — it does NOT replace any of the existing steps.

- [x] Read `package.json` to see the current `prebuild` value verbatim. As of this writing it is:
  ```
  "prebuild": "node scripts/check-node.js && node scripts/verify-native-abi.js && npm run generate:ipc && npm run verify:ipc && npm run verify:exports"
  ```
  Confirm the current chain in your local file before editing — if upstream has added more guards, preserve them.

- [x] Edit `package.json`:
  - Add `"check:contracts": "tsx scripts/check-contracts-aliases.ts"` to the `scripts` object.
  - Append `&& npm run check:contracts` to the **end** of the existing `prebuild` chain. The result should look like:
    ```
    "prebuild": "node scripts/check-node.js && node scripts/verify-native-abi.js && npm run generate:ipc && npm run verify:ipc && npm run verify:exports && npm run check:contracts"
    ```
  - Do NOT remove `check-node`, `verify-native-abi`, `generate:ipc`, `verify:ipc`, or `verify:exports`. Each is load-bearing.

- [x] Run `npm run prebuild` locally; confirm all six steps run and the chain stays green.

- [x] Suggested commit (run only after user approval per AGENTS.md):
  ```
  feat(scripts): append contracts alias-sync auditor to prebuild chain
  ```

### Task 3.4: Run the auditor against the current state

- [x] `npm run check:contracts`.
- [x] If it errors, this is a wave-shipped-with-drift problem — open an issue for the responsible wave, do not patch here.
- [x] If it passes, commit the green result by tagging this milestone:
  ```
  chore(audit): contracts alias-sync clean as of <date>
  ```

---

## Phase 4 — Native-module ABI re-verification

### Task 4.1: Confirm Electron version unchanged across waves

- [x] `git log --oneline -- package.json | head -50` and grep for `electron` version bumps.
- [x] If no bump, skip this phase (only verify-native-abi runs).
- [x] If a bump occurred:
  - [x] `npm run rebuild:native`
  - [x] `node scripts/verify-native-abi.js`
  - [x] Commit the rebuilt `.node` if it's a tracked artifact (it should not be — `.gitignore` covers it).

### Task 4.2: Confirm verify script in prebuild and prestart

- [x] Read `package.json` scripts; confirm:
  - `prebuild` runs `verify-native-abi.js`
  - `prestart` runs `verify-native-abi.js`
- [x] If either is missing, add:
  ```json
  "prestart": "node scripts/verify-native-abi.js",
  ```
- [x] Verify by running `npm run prestart`; should be silent on success.

---

## Phase 4.5 — Cross-wave integration smoke

Per the design's section 6.1, Wave 7 ships a small cross-wave smoke test suite that catches drift the per-wave specs miss. These run as Vitest specs (or, if a check requires full Electron context, as a manual-smoke row).

### Task 4.5.1: Create `scripts/__tests__/cross-wave-smoke.spec.ts`

- [x] Write failing test scaffolds for each automatable check below; commit red:
  ```
  test(cross-wave): scaffold smoke specs (red)
  ```

### Task 4.5.2: Storage namespace separation (Wave 1 ↔ Wave 2)

- [x] Test:
  - Spawn two `Store` instances in a temp `userData`: `new Store({ name: 'usage-tracker' })` and `new Store({ name: 'prompt-history' })`.
  - Write distinct payloads to each.
  - Read back and assert each store sees only its own payload.
- [x] Verify it fails when both stores share a name (regression guard).
- [x] Commit:
  ```
  test(cross-wave): storage namespace separation
  ```

### Task 4.5.3: Wave 4 ClipboardService consumed by Wave 5 quick action

- [x] Test:
  - Grep the renderer source for `WAVE-4-MIGRATE` markers; assert zero results.
  - Construct the `quick-action-dispatcher.service.ts` (or wherever Wave 5 places it) under DI with a `ClipboardService` test double; assert "copy prompt hash" calls `ClipboardService.copyText`, not `navigator.clipboard.writeText`.
- [x] Commit:
  ```
  test(cross-wave): wave 5 copy-prompt-hash uses wave 4 clipboard service
  ```

### Task 4.5.4: Wave 1 → Wave 6 command diagnostics pipeline

- [x] Test:
  - Build a deliberately broken markdown command (e.g., alias collision).
  - Drive `MarkdownCommandRegistry.listCommands()`; assert `diagnostics[]` is non-empty and contains the expected code.
  - With `featureFlags.commandDiagnosticsAvailable = true`, drive `DoctorService.run()`; assert the diagnostic appears in the doctor report's commands section.
- [x] Commit:
  ```
  test(cross-wave): command diagnostics flow through to doctor
  ```

### Task 4.5.5: Frecency feeds Wave 2 SessionPicker

- [x] Test:
  - Seed `UsageStore` with two session entries; record an extra usage event for one.
  - Construct `SessionPickerController` and ask it to render results.
  - Assert the more-recently-used session ranks first.
- [x] Commit:
  ```
  test(cross-wave): session picker uses usage-store frecency
  ```

### Task 4.5.6: Display-item kind ordering (Wave 3)

- [x] Test:
  - Feed `DisplayItemProcessor` a transcript containing a system-event followed by a compaction-summary message and an interrupt-boundary message.
  - Assert the resulting `DisplayItem[]` has `compaction-summary` and `interrupt-boundary` as TOP-LEVEL peers, NOT folded into a `system-event-group`.
- [x] Commit:
  ```
  test(cross-wave): display item branching order
  ```

### Task 4.5.7: rawResponses preservation in verdict (Wave 5)

- [x] Test:
  - Construct a `VerificationResult` with 3 `responses[]` populated with a long string.
  - Run `deriveVerdict(result)`; assert `verdict.rawResponses` equals `result.responses` via `expect(...).toEqual(...)` deep equality.
  - Run the IPC payload roundtrip through Zod parse; assert the array round-trips without loss.
- [x] Commit:
  ```
  test(cross-wave): verdict preserves raw responses
  ```

### Task 4.5.8: Operator artifact redaction (Wave 6)

- [x] Test:
  - Set `process.env.ANTHROPIC_API_KEY = 'sk-test-shouldnotleak'`.
  - Call `OperatorArtifactExporter.export({ session: <fixture> })`.
  - Read the resulting zip's contained JSON files; assert the literal `'sk-test-shouldnotleak'` does not appear in any file.
  - Assert all paths in the bundle are home-relative (start with `~/...` or are non-absolute).
  - Assert `manifest.json` documents the redaction policy.
- [x] Commit:
  ```
  test(cross-wave): operator artifact redaction holds
  ```

### Task 4.5.9: Manual-only checks promoted to smoke checklist

- [x] Items that cannot run as Vitest specs (e.g., `[itemFooter]` projection slot rendering) are tracked in the design's manual smoke checklist (Phase 9 Task 9.3, rows added).
- [x] Confirm row 5 (`[itemFooter]` slot is additive in palette/help hosts) is present in the manual smoke list.

### Task 4.5.10: Run the full cross-wave smoke

- [x] `npx vitest run scripts/__tests__/cross-wave-smoke.spec.ts`
- [x] All 7 automatable checks pass; commit:
  ```
  test(cross-wave): all integration checks green
  ```

---

## Phase 5 — Runbooks

### Task 5.1: `docs/runbooks/command-help-and-palette.md` (Wave 1)

- [x] Sections:
  - Opening the palette (default keybinding, alternative bindings)
  - Searching by name vs alias
  - Categories explained (review, navigation, workflow, session, orchestration, diagnostics, memory, settings, skill, custom)
  - `/help` browser walkthrough
  - Disabled commands and reading the disabled reason
  - Diagnosing alias collisions (where to check; what diagnostic codes mean)
- [x] Add 1–3 screenshots from Phase 6.

### Task 5.2: `docs/runbooks/numeric-hotkeys-and-prompt-recall.md` (Wave 2)

- [x] Sections:
  - Cmd/Ctrl+1..9 visible-instance shortcut (rules, focus behavior)
  - Up/Down prompt recall, stash semantics
  - Ctrl+R reverse-search modal (if shipped)
  - Session picker open/use
  - Model picker open/use
  - Project rail filter performance and the 250ms debounce

### Task 5.3: `docs/runbooks/workflow-transitions-and-resume.md` (Wave 3)

- [x] Sections:
  - Reading a workflow transition policy result (allow/overlap/auto-complete/deny)
  - Advanced history search filters (project scope, time range, source, snippet)
  - Resume picker actions (latest, by-id, switch-to-live, fork-new, restore-fallback)
  - Interrupt boundary display item — what each phase means
  - Compaction summary display item — before/after counts, reason

### Task 5.4: `docs/runbooks/copy-theme-and-link-detection.md` (Wave 4)

- [x] Sections:
  - Clipboard service overview (text, JSON, image)
  - Toast opt-in vs opt-out
  - Theme = system listener behavior
  - Link types (URL, abs path, rel path, Windows path, UNC, error trace)
  - Terminal drawer current scope (boundary only) and follow-up

### Task 5.5: `docs/runbooks/orchestration-hud-and-verdicts.md` (Wave 5)

- [x] Sections:
  - HUD layout in parent sessions
  - Child state badges (active, waiting, failed, stale, idle)
  - Churn count, turn count, heartbeat reading
  - Quick actions (focus, copy hash, open bundle, summarize)
  - Verification verdict statuses (pass, pass-with-notes, needs-changes, blocked, inconclusive)
  - Where to find raw responses

### Task 5.6: `docs/runbooks/doctor-updates-and-artifacts.md` (Wave 6)

- [x] Sections:
  - Banner deep-link to Doctor sections
  - Doctor sections (Startup, Provider, CLI Health, Browser Automation, Commands & Skills, Instructions, Operator Artifacts)
  - CLI update pill behavior
  - Artifact bundle contents
  - Redaction policy (env vars never plaintext, paths home-relative)

### Task 5.7: Cross-link runbooks from Doctor

- [x] For each Doctor section (Wave 6), add the matching runbook URL or local path.
- [x] Verify the link resolves in dev and packaged builds.
- [x] Commit:
  ```
  docs(runbooks): operator runbooks for waves 1–6
  ```

---

## Phase 6 — Screenshot pass against packaged DMG

### Task 6.1: Build the DMG

In this repo, `npm run build` only compiles bundles — it does NOT produce a DMG. Use one of these to package:

- [x] Run `npm run localbuild` (preferred — also rebuilds native modules)
   *or* `npm run build && npm run electron:build -- --mac --config.mac.identity=null` (manual sequence; matches README).
- [x] Package output validated without installing over an existing user app; `npm run smoke:electron` verified the built app layout and packaging-sensitive files.

### Task 6.2: Capture screenshots

- [x] Light mode and dark mode evidence captured for the stable renderer surfaces in the design's smoke checklist.
- [x] Save under `docs/runbooks/screenshots/wave<N>/<surface>.png`.
- [x] Reference each screenshot from the matching runbook section.
- [x] Commit:
  ```
  docs(runbooks): screenshots from packaged DMG smoke
  ```

---

## Phase 7 — Memo cleanup

### Task 7.1: Verify runbook content does not quote memos

- [x] `grep -RIn "copilot-oh-my-codex\|copilot-t3code\|copilot-hermes\|copilot-claw-code\|copilot-opencode" docs/runbooks/`.
- [x] If any matches, paraphrase before deletion (memos are reference material, not redistributable).

### Task 7.2: Delete the six memo source files

- [x] Find them (likely under `docs/superpowers/specs/` or `docs/research/`):
  ```bash
  fd 'copilot-(oh-my-codex|t3code|hermes|claw-code|opencode|copilot)\.md'
  ```
- [x] `git rm <each>`.
- [x] Commit:
  ```
  chore(docs): remove processed comparison memos
  ```

---

## Phase 8 — Architecture doc reconciliation

### Task 8.1: Audit `docs/architecture.md` for drift

- [x] Read the current architecture doc.
- [x] Compare against new modules introduced in Waves 1–6:
  - Command registry + overlay shell + UsageTracker (Wave 1)
  - Visible-instance resolver, prompt-history service, session/model picker controllers (Wave 2)
  - Workflow transition policy, transcript snippet service, advanced history search, resume picker, NL classifier (Wave 3)
  - ClipboardService, link-detection util, theme listener, terminal-drawer scaffold (Wave 4)
  - Orchestration HUD builder, verification verdict deriver, child-state deriver (Wave 5)
  - Doctor service, skill diagnostics, instruction diagnostics, operator artifact exporter, CLI update pill (Wave 6)

### Task 8.2: Update architecture doc minimally

- [x] Add new directories and their roles (e.g., `src/main/diagnostics/`, `src/renderer/app/features/overlay-modes/`).
- [x] Update the IPC table if the doc has one.
- [x] Do **not** rewrite the doc; only diff what changed.
- [x] Commit:
  ```
  docs(architecture): reflect waves 1–6 surfaces
  ```

---

## Phase 9 — Full suite + DMG smoke + sign-off

### Task 9.1: Full automated gate

- [x] `npx tsc --noEmit`
- [x] `npx tsc --noEmit -p tsconfig.spec.json`
- [x] `npm run lint`
- [x] `npm run test` (full suite, not targeted)
- [x] `npm run check:contracts`
- [x] `node scripts/verify-native-abi.js`

If any of these fail, **STOP and fix** before manual smoke. Commit fixes per logical change.

### Task 9.2: Build the DMG

- [x] Run `npm run localbuild` (preferred) or `npm run build && npm run electron:build -- --mac --config.mac.identity=null`. (Note: `npm run build` alone does NOT produce a DMG in this repo.)
- [x] Validate package output without installing over any existing user app.
- [x] Run `npm run smoke:electron` to verify the built app does not have the alias-sync/package-layout class of startup failure.

### Task 9.3: Manual smoke checklist (20 rows)

Run through each row from the design's manual smoke table. Treat **any** failure as a blocker.

- [x] 1. Command palette: open, search by alias, categories visible, disabled-with-reason shown
- [x] 2. `/help` browser: categorized commands, examples render, navigation back to palette works
- [x] 3. Numeric hotkeys: Cmd/Ctrl+1..9 selects visible nth instance; respects filter
- [x] 4. Prompt recall: Up/Down recalls; cancel restores stash; doesn't clobber draft
- [x] 5. Session picker: opens, ranked by frecency, restore works
- [x] 6. Model picker: lists compatible models; ineligible greyed with reason
- [x] 7. Workflow start with overlap: deterministic policy result; UI shows reason + suggestedAction
- [x] 8. Advanced history search: snippet matches, time + project filters, pagination
- [x] 9. Resume picker: latest, by-id, switch-to-live, fork-new all reachable
- [x] 10. Interrupt boundary: display item shows phase + outcome after ESC then resume
- [x] 11. Compaction summary: display item shows before/after counts and reason
- [x] 12. Clipboard: copy text/JSON/image works across all 11 call sites; toast on opt-in surfaces
- [x] 13. System theme change: toggle macOS appearance; app updates without restart when theme = system
- [x] 14. Link detection: URLs, abs/relative paths, error traces all clickable
- [x] 15. Verification verdict: header shows status + confidence + required actions; raw responses accessible
- [x] 16. Orchestration HUD: counts match agent tree; stale/active/waiting/failed badges present
- [x] 17. Quick actions: focus child, copy hash, open diag bundle, summarize children
- [x] 18. Doctor settings tab: banner click deep-links; sections render
- [x] 19. CLI update pill: shows count when updates available; click → CLI Health tab
- [x] 20. Artifact bundle export: bundle written, manifest present, no plaintext secrets, paths home-relative

### Task 9.4: Capture results

- [x] Append a results table to `docs/runbooks/wave-1-6-ipc-audit.md` (or a new `wave-7-smoke-results.md`):

  ```markdown
  | # | Surface | Result | Notes |
  |---|---|---|---|
  ```

- [x] Commit:
  ```
  chore(audit): wave 7 smoke results
  ```

### Task 9.5: Mark plans complete

- [x] Confirm each shipped plan is archived with the `…_completed.md` suffix:
  - Parent cross-repo plan.
  - Waves 1-6 plans already archived before this pass.
  - Wave 7 plan archived by this pass.
- [x] Same for designs (specs/) where applicable.
- [x] Commit per logical group:
  ```
  chore(docs): mark cross-repo usability waves completed
  ```

### Task 9.6: Hand-off note for the user

- [x] Append a short summary to the parent design under a new `## Status: Completed` section listing:
  - Date completed
  - Waves shipped (1–6) plus integration (7)
  - Open follow-up issues (with links) for any drift discovered
  - Operator runbooks delivered

---

## Exit criteria

- All Phase 1–9 tasks checked off.
- Full automated gate green.
- Interactive smoke 20/20 pass with screenshot/selector evidence and packaged-build smoke recorded separately.
- All requested Wave 7 and parent plan/spec files renamed `_completed.md`.
- Memo source files removed.
- Hand-off note in parent design.

If any of the above is not satisfied, Wave 7 is not complete. Report what's missing, do not paper over.
