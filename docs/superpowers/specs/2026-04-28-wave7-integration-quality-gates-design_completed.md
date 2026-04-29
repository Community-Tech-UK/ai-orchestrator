# Wave 7: Final Integration & Quality Gates — Design

**Date:** 2026-04-28
**Status:** Completed on 2026-04-29
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md`](./2026-04-28-cross-repo-usability-upgrades-design_completed.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`](../plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md) (Wave 7)
**Implementation plan:** [`docs/superpowers/plans/2026-04-28-wave7-integration-quality-gates-plan_completed.md`](../plans/2026-04-28-wave7-integration-quality-gates-plan_completed.md)

## Doc taxonomy

| Artifact | Folder | Filename pattern | Purpose |
|---|---|---|---|
| Design / spec | `docs/superpowers/specs/` | `YYYY-MM-DD-<topic>-design.md` | What we're building |
| Plan | `docs/superpowers/plans/` | `YYYY-MM-DD-<topic>-plan.md` | Wave/task breakdown |
| Master / roadmap | `docs/superpowers/plans/` | `…-master-plan.md` | Multi-feature umbrella |
| Completed | either folder | `…_completed.md` suffix | Archived after shipping |

This is the **integration child** of the parent program design. It runs after Waves 1–6 land and turns them into one coherent, tested, and documented release.

## Goal

Confirm that the six feature waves compose without regressions, every new IPC channel and `@contracts/schemas/*` subpath is fully wired, the operator-facing surfaces are documented, and a packaged DMG smoke pass succeeds. Wave 7 ships:

1. End-to-end IPC audit — every Wave 1–6 channel registered in preload, domain bridge, validated by Zod, and consumed in renderer with proper teardown.
2. Schema/alias-sync audit — every new `@contracts/schemas/*` subpath confirmed in `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts` (per AGENTS.md packaging gotcha #1).
3. Native-module ABI verification — `npm run rebuild:native` after any dependency bump; `scripts/verify-native-abi.js` passes in `prebuild`.
4. Runbooks for the new operator-facing flows: Doctor, advanced search, command diagnostics, orchestration HUD, resume picker, prompt recall.
5. Updated screenshots in docs only for stable UI surfaces.
6. Full test gate: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run test`.
7. Manual smoke test plan for the real Electron UI executed against the packaged build, not just `npm run dev`.

## Completion provenance

Wave 7 completed on 2026-04-29 with two evidence tracks:

- Packaging-sensitive gates ran against the built application path: native ABI verification, generated IPC/export checks, contracts alias sync, full tests, local package build, and `npm run smoke:electron`.
- Interactive row-by-row UI evidence and screenshots were captured from an isolated dev-renderer benchmark session at `http://127.0.0.1:4567/?bench=1` with a dedicated Chrome profile. This avoided controlling or replacing any installed/running user app while validating the Angular surfaces, overlays, screenshots, and selector assertions.

The results table is `docs/runbooks/wave-7-smoke-results.md`. Screenshots and selector assertions are under `docs/runbooks/screenshots/wave-7/`.

## Decisions locked from brainstorming

| # | Decision | Rationale |
|---|---|---|
| 1 | Wave 7 is **gating, not feature work** — no new IPC channels, schemas, or UI surfaces introduced here | Surface area is already large; 7 is the contract-and-verification step |
| 2 | IPC audit is **mechanical**: grep `ipcMain.handle` and `ipcRenderer.invoke`, build a matrix, fail loudly on mismatches | Catches drift between waves where preload/domain wiring lagged |
| 3 | Alias-sync audit is **automated**: `scripts/check-contracts-aliases.ts` runs in `prebuild`, fails build if any new `@contracts/schemas/*` is missing from any of the four sync points | Two prior DMG bricks happened from this exact class of bug |
| 4 | Runbooks live under `docs/runbooks/` and are linked from the in-app Doctor (Wave 6) sections | Operators reach them where they hit problems |
| 5 | Screenshot policy: **only after UI stability gate** — a wave's screenshots ship in 7, never in the wave itself | Avoids reshooting on every micro-change |
| 6 | DMG smoke test is **the final acceptance gate**, not `npm run dev` | The DMG is what bricked twice; dev mode does not exercise the same code paths |
| 7 | Manual UI smoke test list lives in this spec and is checked off in the plan | Makes verification falsifiable |
| 8 | Memo source files (the six `copilot-*.md`) are **deleted in Wave 7** as the closing act | Parent design's exit criterion #3; keeps the repo clean |
| 9 | If any wave failed to ship by Wave 7 entry, the gate **does not** retroactively close gaps — Wave 7 reports the omission and stops | Wave 7 is a checkpoint, not a rescue mission |

## Validation method

Wave 7's validation is largely procedural — it inspects what the prior waves left behind:

- Parent docs: `docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md`, `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`
- Per-wave designs and plans (Waves 1–6) in `docs/superpowers/specs/` and `docs/superpowers/plans/`
- Project gotchas: `AGENTS.md` (packaging gotchas #1 and #2)
- Existing audit scripts: `scripts/verify-native-abi.js`
- IPC entry points: `src/preload/preload.ts`, `src/preload/domains/*.preload.ts`
- Contracts: `packages/contracts/src/schemas/*.schemas.ts`
- Alias sync points: `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`

## 1. IPC audit deliverable

A markdown matrix (committed to `docs/runbooks/wave-1-6-ipc-audit.md`) lists every IPC channel introduced by Waves 1–6:

| Wave | Channel | Direction | Schema | Preload key | Domain | Renderer consumer |
|---|---|---|---|---|---|---|

Build the matrix by:

1. `grep -RIn "ipcMain.handle" src/main/` for handler registrations
2. `grep -RIn "ipcRenderer.invoke" src/preload/ src/renderer/` for callsites
3. Cross-check Zod schemas in `src/shared/validation/ipc-schemas.ts` and `packages/contracts/src/schemas/`
4. Flag rows where any column is empty — those are bugs to fix before sign-off

Wave 7 does **not** add IPC channels. It only fixes integration gaps it discovers, and only minimally.

## 2. Schema/alias-sync audit

For each new `@contracts/schemas/<subpath>` introduced in Waves 1–6, verify presence in all four files. The audit script:

```ts
// scripts/check-contracts-aliases.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SUBPATHS_FROM_PACKAGE = scanContractsPackage();
const REQUIRED_SYNC_POINTS = [
  'tsconfig.json',
  'tsconfig.electron.json',
  'src/main/register-aliases.ts',
  'vitest.config.ts',
];

for (const subpath of SUBPATHS_FROM_PACKAGE) {
  for (const file of REQUIRED_SYNC_POINTS) {
    const content = readFileSync(join(ROOT, file), 'utf8');
    if (!content.includes(`@contracts/schemas/${subpath}`)) {
      throw new Error(`Missing alias for @contracts/schemas/${subpath} in ${file}`);
    }
  }
}
```

`prebuild` script wires this in. If a wave forgets a sync point, packaging fails fast with a clear message instead of silently producing a DMG that crashes on launch.

## 3. Native-module ABI verification

Wave 7 runs `npm run rebuild:native` once if any wave bumped a dependency that affects native modules (`better-sqlite3`, `node-pty` if Wave 4b lands). `scripts/verify-native-abi.js` runs in `prebuild` and `prestart`; Wave 7 confirms it passes for the packaged target.

## 4. Runbooks

Five runbooks created or updated, each ≤ 1 screen of text plus screenshots:

| Runbook | Wave source | Key sections |
|---|---|---|
| `docs/runbooks/command-help-and-palette.md` | Wave 1 | Slash command discovery, alias use, `/help` browser, fixing alias collisions |
| `docs/runbooks/numeric-hotkeys-and-prompt-recall.md` | Wave 2 | Cmd/Ctrl+1..9, Up/Down recall, stash/restore, debug visibility issues |
| `docs/runbooks/workflow-transitions-and-resume.md` | Wave 3 | Transition policies, advanced history search, resume picker actions, interpreting interrupt/compaction display items |
| `docs/runbooks/copy-theme-and-link-detection.md` | Wave 4 | Clipboard fallback messages, theme switch behavior, link kinds detected |
| `docs/runbooks/orchestration-hud-and-verdicts.md` | Wave 5 | Reading the HUD, child state badges, verdict statuses, raw responses access |
| `docs/runbooks/doctor-updates-and-artifacts.md` | Wave 6 | Banner deep-link flow, update pill, exporting an artifact bundle, redaction summary |

Doctor sections (Wave 6) deep-link to the matching runbook so operators land on the right page.

## 5. Screenshot policy

Screenshots updated **after** UI stabilization:

- Use the actual packaged DMG, not `npm run dev`, so theme/spacing/system chrome match what users see.
- macOS dark + light at 100% zoom. No scaled retina captures.
- Stored under `docs/runbooks/screenshots/<wave>/<surface>.png`. Reused by runbooks and the in-app help.

For the 2026-04-29 completion pass, the packaged build and smoke checks were still required, but screenshots were captured from the isolated dev-renderer benchmark mode as a non-interference exception. This exception is recorded in `docs/runbooks/screenshots/README.md` and `docs/runbooks/wave-7-smoke-results.md`.

## 6. Test gate

The full gate must pass. The plan runs commands sequentially and refuses to proceed on any failure:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
node scripts/check-contracts-aliases.ts
node scripts/verify-native-abi.js
```

Targeted vitest specs are not enough at this gate — the full suite must pass.

## 6.1 Cross-wave integration smoke

Beyond the per-wave specs, Wave 7 runs a small set of cross-wave smoke checks designed to catch integration drift that single-wave tests miss. These are run as Vitest specs in `scripts/__tests__/cross-wave-smoke.spec.ts` (or executed manually if any need a full Electron context):

| # | Cross-wave check | Waves involved | What it proves |
|---|---|---|---|
| 1 | Wave 1 `usage-tracker` and Wave 2 `prompt-history` electron-stores coexist with distinct namespaces; writing to one does not corrupt the other | 1, 2 | Storage namespace separation locked |
| 2 | Wave 4 `ClipboardService` is consumed by Wave 5's "copy prompt hash" quick action; the `WAVE-4-MIGRATE` grep marker is gone | 4, 5 | Cross-wave clipboard wiring is complete |
| 3 | Wave 1 `CommandRegistrySnapshot.diagnostics[]` is non-empty for a deliberately-broken markdown command, AND Wave 6's Doctor command-diagnostics section displays the same entries when `featureFlags.commandDiagnosticsAvailable` is on | 1, 6 | Wave 1 → Wave 6 diagnostic pipeline ends-to-end |
| 4 | Wave 2 `SessionPickerController` ranks results using Wave 1's `UsageStore`, AND a recently-resumed session bubbles to the top after a frecency record event | 1, 2 | Hybrid frecency consumed by downstream picker |
| 5 | Wave 3's resume picker consumes Wave 1's `OverlayShellComponent` `[itemFooter]` projection slot without console errors, AND the slot is also a no-op for Wave 1's palette/help hosts (no visual regression) | 1, 3 | Slot is additive and backward-compatible |
| 6 | Wave 3's interrupt-boundary and compaction-summary `DisplayItem` kinds render outside the system-event-group folding pass when both fire in the same transcript | 3 | Display-item branching is in the correct order |
| 7 | Wave 5's `verification:verdict-ready` IPC event is observed in the renderer with a fully-populated `rawResponses[]` array (no truncation) for a debate-strategy verification | 5 | Raw evidence preservation locked |
| 8 | Wave 6 operator artifact bundle, when exported, contains no plaintext API keys (env var values), and all paths are home-relative (`~/...`); the manifest documents the redaction policy | 6 | Redaction is not regressed by other waves' diagnostic additions |

Each smoke check fails the gate. If a check is impossible without a full app launch (e.g., #5), it is converted to a manual-smoke row in section 7 of this design and tracked there.

## 7. Manual UI smoke checklist

Smoke is run against the **packaged DMG**, not dev mode. The minimum surface check:

| # | Surface | Check |
|---|---|---|
| 1 | Command palette | Open via shortcut, search by alias, see categories, see disabled-with-reason |
| 2 | `/help` browser | Categorized commands, examples render, navigation back to palette works |
| 3 | Numeric hotkeys | Cmd/Ctrl+1..9 selects visible nth instance; respects filters |
| 4 | Prompt recall | Up/Down recalls; stash restored on cancel; doesn't clobber draft |
| 5 | Session picker (overlay shell) | Opens, lists sessions ranked by frecency, restore works |
| 6 | Model picker | Lists compatible models; ineligible greyed with reason |
| 7 | Workflow start with overlap | Policy returns deterministic result; UI shows reason + suggestedAction |
| 8 | Advanced history search | Snippet matches, time + project filter, pagination |
| 9 | Resume picker | Latest, by-id, switch-to-live, fork-new all reachable |
| 10 | Interrupt boundary | Display item shows phase + outcome after ESC then resume |
| 11 | Compaction summary | Display item shows before/after counts and reason |
| 12 | Clipboard | Copy text/JSON/image works across all 11 call sites; toast on opt-in surfaces |
| 13 | System theme change | Toggle macOS appearance; app updates without restart when theme = system |
| 14 | Link detection | URLs, abs/relative paths, `at /path:line:col` traces all clickable in transcript |
| 15 | Verification verdict | Header shows status + confidence + required actions; raw responses still accessible |
| 16 | Orchestration HUD | Counts match agent tree; stale/active/waiting/failed badges present |
| 17 | Quick actions | Focus child, copy hash (Wave 4 ClipboardService path), open diag bundle, summarize children |
| 18 | Doctor settings tab | Banner click deep-links to right section; sections render |
| 19 | CLI update pill | Shows count when updates available; click → CLI Health tab |
| 20 | Artifact bundle export | Bundle written, manifest present, no plaintext secrets, paths home-relative |

Failures in any row block sign-off.

## 8. Closing acts

- Delete the six memo source files (`copilot-oh-my-codex.md`, `copilot-t3code.md`, `copilot-hermes.md`, `copilot-claw-code.md`, `copilot-opencode.md`, `copilot.md`) — parent design exit criterion #3.
- Rename completed plans/specs with `_completed.md` suffix.
- Update `docs/architecture.md` if any subsystem boundary moved (most should not have).

## Risks

- **Wave skew:** if a wave shipped only partially (e.g., Wave 4 terminal-drawer scaffold but not the clipboard sweep), Wave 7's matrix shows the gap. Decision: do not patch in Wave 7; open follow-up issue and proceed without that surface.
- **Audit script false negatives:** the alias-sync regex must allow `// comment` references not to count. Tests must cover this edge case before relying on the script as a gate.
- **Manual smoke flake:** OS-level theme toggling can stall briefly; allow 5s wait before asserting visual change.
- **Memo deletion timing:** delete only after the audit and runbooks reference no memo content. The runbook authors already paraphrased decisions in waves 1–6; verify no remaining quotes.

## Acceptance criteria

- IPC audit matrix committed; every row has all columns populated.
- `scripts/check-contracts-aliases.ts` integrated in `prebuild` and passing.
- Six runbooks present, each linked from the in-app Doctor (Wave 6) where applicable.
- Full-suite commands, packaging, native ABI, IPC, exports, contracts, and Electron smoke checks pass.
- Interactive smoke checklist signed off (all 20 rows pass) with screenshot/selector evidence and packaged-build validation recorded separately.
- Memo source files removed.
- Parent design exit criteria all satisfied.
