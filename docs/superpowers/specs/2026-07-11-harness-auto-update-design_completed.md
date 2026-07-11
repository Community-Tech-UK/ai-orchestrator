# Harness Cross-Platform Auto-Update Design (Completed)

**Date:** 2026-07-11
**Status:** Implemented

## Objective

Give installed Harness applications a dependable, signed, cross-platform update path. Packaged applications check for stable releases in the background, download the matching platform artifact silently, offer **Restart to update**, and install an already-downloaded update during the next normal quit if the operator postpones the restart.

## Current State

Harness already includes `electron-updater`, an `AutoUpdateService`, IPC handlers, preload methods, and generated update metadata during local packaging. The production path is incomplete:

- `electron-builder.json` contains a placeholder generic feed.
- macOS packaging only targets arm64 DMG, omits the ZIP required by the macOS updater, and disables notarization.
- there is no release workflow that creates versioned, signed artifacts and publishes their update manifests.
- the updater is configured for manual download and does not schedule background checks.
- no renderer surface presents downloaded application updates.
- the packaging pre-hook hardcodes the macOS desktop helper to arm64.

## Decisions

### Release hosting

Use public GitHub Releases in `Community-Tech-UK/ai-orchestrator` as the stable update provider. The repository is public, so installed clients require no embedded credential or per-machine token. Keep package-manager distribution and a generic R2/S3 feed outside the initial scope.

### Supported update targets

- macOS arm64: DMG plus updater ZIP containing the signed and notarized application.
- macOS x64: DMG plus updater ZIP containing the signed and notarized application.
- Windows x64: Authenticode-signed NSIS installer.
- Linux x64: AppImage.
- Linux arm64: AppImage.

The existing Windows portable executable and Linux DEB may remain manual distribution artifacts, but they are not part of the self-update contract. Windows arm64 remains unsupported until every native dependency and bundled executable has a verified arm64 artifact; RTK currently has no Windows arm64 binary.

### Release trigger and versions

An explicit stable semantic-version tag (`vX.Y.Z`) triggers the release workflow. The tag version and `package.json` version must match. Stable clients ignore GitHub prereleases. Published versions and assets are immutable; correcting a release requires a higher patch version.

### Installed application behaviour

Only packaged applications enable update checks. After the application is ready, Harness waits 15 seconds, checks once, and checks again every four hours with overlap protection. Network or feed errors are logged but do not interrupt startup or active work.

When a newer version is found, Harness downloads it automatically. After download:

- show a persistent application-level notice with the available version;
- provide **Restart to update** and **Later** actions;
- never restart automatically while the application is running;
- install on the next normal application quit when **Later** was chosen;
- retain a manual **Check for updates** action in Settings or About;
- keep status and errors visible on the manual update surface.

The renderer consumes a typed status contract through the existing IPC boundary. It does not import or call `electron-updater` directly.

## Architecture

### Release workflow

Add `.github/workflows/release.yml` with a preflight job and a native build matrix.

Preflight:

1. Check out the exact tag commit with full tag history.
2. Validate the `vX.Y.Z` tag against `package.json`.
3. Install pinned dependencies with `npm ci --legacy-peer-deps`, matching the
   peer-resolution mode used by the current lockfile.
4. Run the canonical quality gates before packaging.

Native builds:

- macOS builds run on macOS and compile the Swift desktop helper for the matrix architecture.
- Windows builds run on Windows so native Electron modules and NSIS packaging are produced on the target platform.
- Linux builds run on Linux for x64 and arm64, using native or explicitly supported emulated runners only when packaged native modules are verified.
- each job produces installers, updater ZIPs where required, blockmaps, and channel manifests.

Publish:

1. Download matrix artifacts into one release job.
2. Merge architecture-specific macOS update metadata into the canonical stable manifest where required.
3. Reject missing, duplicate, placeholder, or inconsistent manifests.
4. Create one GitHub Release and upload all update assets with least-privilege `contents: write` permission limited to the publish job.

### Signing

macOS uses a Developer ID Application certificate, hardened runtime, and Apple notarization through electron-builder's supported environment variables. Signing and notarization must cover the Electron application, Swift helper, RTK binary, and bundled SEA executables. The workflow verifies the final signature and Gatekeeper assessment before publishing.

Windows uses an Authenticode certificate supplied through GitHub Actions secrets. The workflow verifies the signature before publishing. Unsigned macOS or Windows builds may be created for local development but must never be published by the stable release workflow.

Secrets remain exclusively in GitHub Actions secrets or environments. No certificate, password, API key, session value, or realistic placeholder secret is written to the repository, application bundle, logs, fixtures, or test snapshots.

### Updater service

Extend the existing main-process updater service rather than replacing it. It owns:

- initialization and updater event wiring;
- delayed startup check and periodic polling;
- single-flight protection for checks and downloads;
- automatic downloads and install-on-quit configuration;
- explicit restart-and-install;
- timer cleanup during shutdown and tests;
- normalized typed status, including timestamps and actionable errors;
- structured logs without credentials or signed URLs.

The service must expose a reset/cleanup path compatible with repository singleton testing conventions. IPC registration remains an adapter and must not own timers or duplicate lifecycle state.

### Renderer experience

Add a small signal-backed update store that initializes from `update:get-status` and subscribes to `update:status-changed`. A global notice appears only after an update has downloaded. It shows the target version and the two actions. Settings/About exposes current version, last check, current update state, manual check, and retry when relevant.

The update notice must be keyboard accessible, screen-reader labelled, and visually subordinate to active work. Choosing **Later** hides or minimizes the notice for the current session without discarding the downloaded update.

## Failure Handling

- Missing feed: updater reports disabled/unavailable diagnostics; application continues normally.
- Offline or GitHub unavailable: record a sanitized error, return to a retryable state, and try again at the next interval.
- Concurrent checks: reuse or skip the in-flight operation.
- Download failure: preserve the available version and permit retry.
- Install failure: keep the application open where Electron permits and surface a manual retry.
- Active agents or loops: never trigger an automatic restart.
- Bad published release: publish a higher patch version; never replace assets under an existing version.
- Unsupported installation form: clearly report that the installation must be updated through its package manager or a supported installer.

## Verification

### Automated checks

- updater state-machine tests for initialization, timers, overlap, background checks, automatic download, deferred install, errors, and cleanup;
- IPC handler tests for status, manual check, retry, and install;
- renderer store and component tests for every meaningful status and action;
- release configuration tests for required platform targets, provider, absence of placeholder URLs, and version/tag validation;
- workflow validation and manifest validation tests;
- canonical repository typecheck, lint, file-size, and test gates.

### Packaged update tests

For every supported platform/architecture, install a signed version N, publish or serve signed version N+1 through a controlled test channel, and verify:

1. N starts without update-related delay or error.
2. N discovers N+1 and downloads the correct architecture artifact.
3. **Later** leaves active work untouched.
4. **Restart to update** installs N+1 and relaunches successfully.
5. A downloaded update installs on the next normal quit.
6. Application data, settings, databases, sessions, and remote-node configuration remain intact.
7. The resulting application reports version N+1 and passes signature/platform trust checks.

Real packaged N-to-N+1 testing is a release gate because unit tests cannot prove signing, manifest selection, replacement, or relaunch behaviour.

## Rollout

1. Build and validate unsigned local artifacts without publishing.
2. Configure signing credentials in GitHub Actions.
3. Publish a controlled prerelease/test channel and complete N-to-N+1 tests on each target.
4. Publish the first stable tag release.
5. Install the stable build on the existing Harness computers and confirm update discovery with the next patch release.

Staged percentages, nightly channels, package-manager automation, Windows arm64, and a private CDN are deferred until fleet size or operational needs justify them.
