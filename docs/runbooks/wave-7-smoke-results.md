# Wave 7 Smoke Results

Date: 2026-04-29

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
| `npm run test` | Pass | 473 files, 4,760 tests. |
| `npm run rebuild:native` | Pass | better-sqlite3 rebuilt for Electron ABI 143. |
| `npm run build` | Pass | Renderer, main, preload, and worker agent built. |
| `npm run localbuild` | Pass | Unsigned local arm64 DMG built at `release/AI Orchestrator-0.1.0-arm64.dmg`. |
| `npm run smoke:electron` | Pass | Native ABI, IPC sync, exports, required Electron files. |
| Packaged app direct launch | Pass | `release/mac-arm64/AI Orchestrator.app/Contents/MacOS/AI Orchestrator` exited with code 0. |

## Manual UI Checklist

The 20-row interactive UI smoke checklist from the Wave 7 design remains the operator checklist for a human pass against the packaged app. The CLI validation above confirms build, packaging, IPC, contracts, native ABI, and cross-wave logic; it does not replace visual/manual checks such as shortcut operation, theme toggling, or screenshot capture.
