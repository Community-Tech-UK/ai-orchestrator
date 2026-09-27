# Harness Cross-Platform Auto-Update Live Test

## Status — completed by consolidation 2026-09-27

Open here: 0 · Closed by transfer: 9 · Failed: 0

The release prerequisites were rechecked live on 2026-09-27 and remain absent: zero Actions
secrets, zero `v*` tags, zero GitHub Releases and zero `release.yml` runs; version remains `0.1.0`.
All nine signed-release and target-machine checks were therefore moved intact to
[RES-011 in the consolidated human/external checklist](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-011--signed-cross-platform-n-to-n1-auto-update-release-campaign).
That document is now the only active owner. No updater failure was reproduced.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Prerequisites: rebuild and publish signed stable releases from
> `.github/workflows/release.yml`, then run these checks on real target machines.
> This document tracks checks that cannot be proven by unit tests, an unsigned
> local package, or repository inspection. See the source
> [implementation plan](./2026-07-11-harness-auto-update-plan_completed.md).

## Release prerequisites

- GitHub Actions secrets are configured: `MAC_CSC_LINK`,
  `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, `WINDOWS_CSC_LINK`, and
  `WINDOWS_CSC_KEY_PASSWORD`.
- `package.json#version` is a new stable version and the pushed tag exactly
  matches it as `vX.Y.Z`.
- The Release workflow passes all five native build jobs and the publish job.
- `gh release view vX.Y.Z --json assets,isDraft,isPrerelease` shows a public,
  non-draft, non-prerelease release containing every asset accepted by
  `npm run release:validate-assets`.
- A signed Harness version N is installed on each target before version N+1 is
  published. Use a second patch release or a second machine per target to test
  both explicit restart and install-on-normal-quit paths.

## Shared N-to-N+1 behavior

Run these steps on macOS arm64, macOS x64, Windows x64, Linux x64, and Linux
arm64:

1. Launch installed version N and confirm Settings → General → Application
   updates reports N without delaying the rest of startup.
2. Create durable test state: one setting change, one local Harness session,
   one workspace selection, and one remote-node entry if that feature is used
   on the machine.
3. Start a harmless long-running agent or loop so an automatic restart would be
   obvious.
4. Publish signed version N+1 and leave Harness open for at least 30 seconds.
5. Confirm the update downloads without a manual click and the global notice
   says `Harness N+1 is ready`.
6. Click **Later**. Confirm the notice hides for this renderer session, the
   running agent/loop remains active, and Harness does not quit or restart.
7. Reopen Settings → General and confirm N+1 is still reported as ready.
8. On the explicit-restart machine, click **Restart to update**. Confirm Harness
   closes, installs N+1, relaunches once, and Settings reports N+1.
9. On the normal-quit machine, choose **Later**, quit Harness normally, and
   launch it again. Confirm N+1 was installed during quit and Settings reports
   N+1.
10. Confirm the setting, session, workspace selection, application database,
    and remote-node entry from step 2 are unchanged.
11. Disconnect networking and use **Check for updates**. Confirm startup and
    active work remain usable, the settings card shows a retryable error, and a
    later online check succeeds.

Expected result: every target selects its own architecture payload, never
restarts active work automatically, supports both install paths, and preserves
application data.

Why deferred: needs a real signed N and N+1 release; none exists yet (see
Release prerequisites).

## macOS arm64 and x64 trust checks

For each downloaded DMG and installed application:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Harness.app
spctl --assess --type execute --verbose=2 /Applications/Harness.app
xcrun stapler validate /Applications/Harness.app
file /Applications/Harness.app/Contents/MacOS/Harness
file /Applications/Harness.app/Contents/Resources/desktop-helper/desktop-helper
```

Expected result: signature verification succeeds, Gatekeeper reports an
accepted notarized Developer ID application, the stapled ticket validates, and
both the Electron executable and Swift helper report the target architecture.

Why deferred: needs a Developer-ID-signed, notarized release build; the current
local/installed build is ad-hoc signed only (Gatekeeper `rejected`, no stapled
ticket — reconfirmed 2026-07-26).

## Windows x64 trust check

Run in PowerShell against the installed executable and downloaded NSIS
installer:

```powershell
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\Harness\Harness.exe" | Format-List Status,StatusMessage,SignerCertificate
Get-AuthenticodeSignature ".\Harness-N+1-win-x64.exe" | Format-List Status,StatusMessage,SignerCertificate
```

Expected result: both signatures have `Status: Valid`, Windows identifies the
configured publisher, and the update installs without a SmartScreen
unknown-publisher warning attributable to an unsigned binary.

Why deferred: needs a Windows-code-signed release build; the installed build on
`windows-pc` reports `NotSigned` (reconfirmed 2026-07-13).

## Linux x64 and arm64 runtime check

Launch the actual AppImage file, not an extracted directory or DEB install:

```bash
chmod +x Harness-N-linux-ARCH.AppImage
./Harness-N-linux-ARCH.AppImage
```

After updating, inspect the executable selected by the AppImage integration:

```bash
file Harness-N+1-linux-ARCH.AppImage
```

Expected result: the AppImage runs on the matching native architecture, the
`APPIMAGE` runtime environment is present, N+1 replaces N through the AppImage
update path, and the app relaunches successfully. A DEB installation is not an
auto-update test target.

Why deferred: needs a published N and N+1 AppImage release; none exists yet.

## Evidence run — 2026-09-24

Current GitHub preflight was run against `Community-Tech-UK/ai-orchestrator`:

| Prerequisite | Command | Result |
| --- | --- | --- |
| Repository Actions secrets | `gh api repos/Community-Tech-UK/ai-orchestrator/actions/secrets --jq '.total_count'` | `0` |
| Pushed release tags | `git tag -l 'v*' \| wc -l` | `0` |
| GitHub Releases | `gh release list --repo Community-Tech-UK/ai-orchestrator --limit 10 --json tagName --jq 'length'` | `0` |
| Release workflow runs | `gh run list --repo Community-Tech-UK/ai-orchestrator --workflow release.yml --limit 10 --json databaseId --jq 'length'` | `0` |
| `package.json#version` | — | `0.1.0` |

The updater's main-process, IPC, renderer-store, settings-card, global-banner, and release-asset/tag
contract suites passed: `7 files · 44 tests passed`. There is no released signed N or N+1 artifact
with which to execute a real update, trust, or data-preservation check, and no auto-update product
defect was reproduced. The nine checks remain deferred solely on the release prerequisites and
target machines listed above.

## Completion

The source checklist is complete by consolidation. RES-011 now owns the release tags,
machine/OS versions, artifact filenames, target matrix and both install paths.

## Closed checks

All nine checks were transferred to RES-011 on 2026-09-27 because none can run until a signed N and
N+1 release exists. This is administrative closure of the source document, not evidence that the
cross-platform release campaign has run.

## Prior verification (release prerequisites, through 2026-08-31)

Checked repeatedly and identically since 2026-07-12 (also 2026-07-13, 07-26, 07-29,
08-12, 08-18, 08-19, 08-24, 08-31): every run found the same blocked state, live
against GitHub, not inferred. The most recent prior check was 2026-08-31; the current preflight is
recorded above under Evidence run — 2026-09-24:

| Prerequisite | Command | Result |
| --- | --- | --- |
| Repository Actions secrets | `gh secret list` | no entries |
| Pushed release tag | `git tag -l 'v*'` | no entries |
| GitHub Releases | `gh release list --limit 10` | no entries |
| Release workflow runs | `gh run list --workflow release.yml --limit 10` | no runs (workflow has never fired) |
| `package.json#version` | — | `0.1.0`, unchanged since first check |

A local ad-hoc/Apple-Development code-signing identity exists on the build machine
(`security find-identity -v -p codesigning`, Team ID `GJL9WJ4S4W`), but this is not a
substitute for the CI-supplied Developer ID / notarization secrets the release workflow
needs — the two are unrelated (confirmed 2026-08-18, reconfirmed 2026-08-19/08-24).
The `.worktrees/harness-auto-update-v0.1.0` AIO-managed worktree exists on branch
`release/harness-auto-update-v0.1.0` and has been left untouched throughout, per policy.

**Residual, unchanged since 2026-08-18:** James must (1) add the seven release secrets
(`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`) as repo or
environment secrets, (2) bump the version and push a `vX.Y.Z` tag, and (3) let
`release.yml` complete and publish a non-draft, non-prerelease release with the
expected assets. Only then do any of the checks above become runnable on any target.
Nothing in this doc is agent-reachable today.
