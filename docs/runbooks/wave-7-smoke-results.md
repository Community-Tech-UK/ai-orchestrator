# Wave 7 Smoke Results

Date: 2026-04-29

## Provenance

Packaged build, native ABI, IPC, contracts, exports, and Electron file-layout checks were validated with the automated commands below. The row-by-row interactive UI checks and screenshots were captured from an isolated dev-renderer benchmark session at `http://127.0.0.1:4567/?bench=1` using a dedicated Chrome profile. This avoided controlling or replacing any installed/running user app while still exercising the Angular surfaces and benchmark fixtures for the 20-row checklist.

Evidence bundle:

- Screenshots: `docs/runbooks/screenshots/wave-7/`
- Selector/count assertions: `docs/runbooks/screenshots/wave-7/smoke-evidence.json`

## Automated Gate

| Check | Result | Notes |
|---|---|---|
| `npm run check:contracts` | Pass | 22 exported schema subpaths verified across all four alias sync points. |
| `npx vitest run scripts/__tests__/check-contracts-aliases.spec.ts` | Pass | 9 tests. |
| `npx vitest run scripts/__tests__/cross-wave-smoke.spec.ts` | Pass | 7 cross-wave smoke checks. |
| `npx tsc --noEmit` | Pass | Renderer/app typecheck. |
| `npx tsc --noEmit -p tsconfig.electron.json` | Pass | Main/preload typecheck. |
| `npx tsc --noEmit -p tsconfig.spec.json` | Pass | Spec/test typecheck. |
| `npm run lint` | Pass | Angular ESLint. |
| `npm run prebuild` | Pass | Native ABI, IPC generation/verification, package export audit, contracts alias audit. |
| `npm run prestart` | Pass | Same startup guards as prebuild. |
| `npm run verify:architecture` | Pass | `docs/generated/architecture-inventory.json` regenerated and verified. |
| `npm run test` | Pass | 475 files, 4,771 tests. |
| `npm run rebuild:native` | Pass | better-sqlite3 rebuilt for Electron ABI 143. |
| `npm run build` | Pass | Renderer, main, preload, and worker agent built. |
| `npm run localbuild` | Pass | Unsigned local arm64 DMG built at `release/AI Orchestrator-0.1.0-arm64.dmg`. |
| `npm run smoke:electron` | Pass | Native ABI, IPC sync, exports, required Electron files. |
| Packaged app file-layout smoke | Pass | `release/mac-arm64/AI Orchestrator.app` verified by `npm run smoke:electron`; no installed app was controlled. |

## Interactive UI Checklist

| # | Surface | Result | Evidence |
|---|---|---|---|
| 1 | Command palette | Pass | `command-palette-dark.png`; `commandPalette.open=true`, 4 rows, search input present. |
| 2 | `/help` browser | Pass | `command-help-browser-dark.png`; `commandHelp.open=true`, browser command present. |
| 3 | Numeric hotkeys | Pass | `smoke-evidence.json`; selected instance changed from `wave7-parent` to `wave7-child-failed`. |
| 4 | Prompt recall | Pass | `prompt-recall-dark.png`; recalled prompt value matched the benchmark prompt. |
| 5 | Session picker | Pass | `session-picker-light.png`; 3 rows with live and history entries. |
| 6 | Model picker | Pass | `model-picker-light.png`; 39 rows, current model and provider models present. |
| 7 | Workflow start with overlap | Pass | Cross-wave workflow policy specs plus dashboard benchmark state. |
| 8 | Advanced history search | Pass | `prompt-history-search-dark.png`; prompt history entries present. |
| 9 | Resume picker | Pass | `resume-picker-dark.png`; latest and fallback actions present. |
| 10 | Interrupt boundary | Pass | `dashboard-orchestration-dark.png`; display-item processor specs cover boundary ordering. |
| 11 | Compaction summary | Pass | `dashboard-orchestration-dark.png`; display-item processor specs cover top-level compaction summaries. |
| 12 | Clipboard | Pass | Clipboard service specs and quick-action dispatcher specs verify shared copy paths. |
| 13 | System theme change | Pass | Light and dark benchmark screenshots plus settings-store theme listener specs. |
| 14 | Link detection | Pass | Dashboard benchmark link/path evidence plus shared link-detection specs. |
| 15 | Verification verdict | Pass | `verification-results-dark.png`; verdict header and export button present. |
| 16 | Orchestration HUD | Pass | `dashboard-orchestration-dark.png`; HUD and child attention states visible. |
| 17 | Quick actions | Pass | Dashboard benchmark state plus quick-action dispatcher specs. |
| 18 | Doctor settings tab | Pass | `settings-doctor-artifacts-light.png`; Doctor operator artifacts tab rendered. |
| 19 | CLI update pill | Pass | `dashboard-orchestration-dark.png`; title-bar pill showed `2 updaters` and component spec verifies CLI Health navigation. |
| 20 | Artifact bundle export | Pass | `settings-doctor-artifacts-light.png`; export result showed a zip path, byte count, and file count. |

The captured session recorded zero console errors and zero page exceptions.
