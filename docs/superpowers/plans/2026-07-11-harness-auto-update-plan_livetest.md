# Harness Cross-Platform Auto-Update Live Test

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

## Completion

Record the release tags, machine/OS versions, artifact filenames, and observed
results for every row. Rename this file to
`2026-07-11-harness-auto-update-plan_livetest_completed.md` only after all five
target rows and both install paths pass with evidence.
