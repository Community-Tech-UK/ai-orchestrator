# Electron and Native-Module Packaging

Use this runbook when changing Electron, contract subpaths, or compiled dependencies. The packaged app can pass TypeScript checks and still fail at startup if these runtime details drift.

## Contract Subpaths

Files in `packages/contracts/src/schemas/` and `packages/contracts/src/types/` use suffixes such as `.schemas.ts` and `.types.ts`, while imports use short subpaths such as `@contracts/schemas/name`.

When adding a subpath, keep these in sync:

1. `tsconfig.json`
2. `tsconfig.electron.json`
3. `src/main/register-aliases.ts` (`exactAliases`)
4. `vitest.config.ts` when tests import the path

The TypeScript aliases are type-check-only; they do not rewrite emitted JavaScript. Missing the runtime alias can crash the packaged app with `Cannot find module`.

## Electron Upgrades

`better-sqlite3` must match Electron's ABI. The postinstall hook covers clean installs, but installing a new Electron version alone does not rerun it.

After changing Electron, run:

```bash
npm run rebuild:native
```

`scripts/verify-native-abi.js` runs in `prebuild` and `prestart` and checks the bundled binary against the installed Electron ABI.

## New Compiled Dependencies

`electron-builder.json` sets `npmRebuild` to `false`; package-time node-gyp compilation is intentionally disabled so build hosts do not require an MSVC/C++ toolchain.

Current N-API modules (`node-pty`, `lmdb`, and `msgpackr-extract`) ship ABI-stable prebuilt binaries. `better-sqlite3` is non-N-API and is handled by the explicit native rebuild plus ABI verification.

For a new non-N-API native module, either:

1. Add it to `NATIVE_MODULES` in both `scripts/rebuild-native-modules.js` and `scripts/verify-native-abi.js` (preferred), or
2. Re-enable `npmRebuild` and accept the compiler-toolchain requirement on every build host.

Check for N-API support through `node-addon-api`/`node-gyp-build`, a `prebuilds/` directory, or platform prebuilt packages. A non-N-API module omitted from the rebuild and verification scripts can ship a wrong-ABI binary silently.

## Signed Releases and Auto-Updates

Stable Harness releases are built by `.github/workflows/release.yml` from an explicit `vX.Y.Z` tag. The tag must exactly match `package.json#version`; run this before tagging:

```bash
npm run release:validate-tag -- vX.Y.Z
```

The release matrix produces:

- macOS arm64 and x64 DMG and ZIP artifacts;
- Windows x64 NSIS;
- Linux x64 and arm64 AppImage;
- external blockmaps for DMG/ZIP/NSIS, embedded AppImage blockmaps, and
  canonical `latest*.yml` update manifests.

The Windows portable executable and Linux DEB are manual distribution formats, not self-update targets.
Build them explicitly with `npx electron-builder --win portable --x64` or
`npx electron-builder --linux deb --x64`; they are intentionally absent from
the default target list so they cannot collide with updater artifacts.

The matrix uses native GitHub-hosted runners (`macos-15`, `macos-15-intel`,
`windows-2025`, `ubuntu-24.04`, and `ubuntu-24.04-arm`). It sets
`HARNESS_BUILD_ARCH` before packaging so the bundled Swift desktop helper is
compiled for the release target rather than whichever architecture the runner
happens to use.

### GitHub Actions credentials

Configure these repository or release-environment secrets without copying their values into repo files or logs:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `WINDOWS_CSC_LINK`
- `WINDOWS_CSC_KEY_PASSWORD`

`MAC_CSC_LINK` contains the exported Developer ID Application certificate in an electron-builder-supported form. `APPLE_API_KEY` contains the App Store Connect API private key text; the workflow writes it to a temporary runner file. Windows uses an Authenticode code-signing certificate supported by electron-builder.

The release workflow fails closed when platform signing credentials are missing. It verifies macOS code signatures, Gatekeeper assessment, and notarization stapling, and verifies the Windows Authenticode signature before uploading artifacts.
It also passes electron-builder's `forceCodeSigning` option for macOS and
Windows, so a present-but-invalid certificate cannot silently produce an
unsigned stable build.

`npm run localbuild` intentionally narrows package output on macOS and Windows:
an arm64 DMG on macOS or an x64 NSIS setup executable on Windows. The macOS
package is signed. The localbuild-only custom signer uses
an installed Developer ID Application or Apple Development identity for local
builds, but does not request a trusted timestamp because local packages are not
notarized and should not depend on Apple's timestamp service being available.
Packaging fails if no real identity is available or if Harness and the bundled
desktop helper do not end up with the same non-empty Team ID. This is required
for macOS to attribute the helper's Accessibility calls to Harness consistently.
Stable releases continue to use electron-builder's imported Developer ID
identity with timestamping and notarization, and verify the helper's Team ID in
the release workflow.

### Publishing

1. Make sure the normal CI workflow is green.
2. Set `package.json#version` to the new stable version and update the lockfile.
3. Run the canonical local gates.
4. Create and push the matching tag, for example `v0.2.0`.
5. Confirm all five native build jobs and the final publish job pass.
6. Test an installed previous version updating to the new release on each supported target.

Published release assets are immutable. If a release is faulty, publish a higher patch version; never replace files underneath an existing version or tag.
The publish job checks for an existing GitHub Release before upload and rejects
duplicate filenames while collecting matrix artifacts.

For unsigned local macOS packaging, use:

```bash
npm run electron:build -- --mac --dir --config.mac.identity=null --config.mac.notarize=false
```

This unsigned command is for packaging diagnostics only. Its ad-hoc signature
does not provide a stable TCC identity, so Computer Use Accessibility grants may
appear enabled in System Settings while the desktop helper remains untrusted.
