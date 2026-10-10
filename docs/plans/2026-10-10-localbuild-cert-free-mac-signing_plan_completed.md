# localbuild on a Mac without a code-signing certificate

Status: implemented, independently verified, and committed on 10 October 2026.
Unrelated uncommitted work in the same checkout was left unstaged.

## Why

Jim Taylor is building Harness from source on a Mac with no Apple certificate
installed. James, 10 October 2026: "he's on a mac so this needs fixing
somehow". `npm run localbuild` could not give him a runnable app:

1. `MacPackager.sign()` calls `findSigningIdentity`, and with no identity it
   returns `false` before the custom `mac.sign` hook ever runs, and the same
   silent skip happens with `CSC_IDENTITY_AUTO_DISCOVERY=false`, an identity
   qualifier that matches nothing, `mac.identity: null`, or the PR-build guard.
   Nothing signs the app at all in those cases.
2. Unsigned arm64 code never loads on Apple Silicon, and the bundle's native
   modules (`better_sqlite3.node`, `node-pty` prebuilds) are exactly the files
   that break first. A build with a real certificate signs them (they carry the
   team identifier in the installed app); `codesign --deep` on its own does not
   reach loose Mach-O files under `Contents/Resources` (proved below).

## Change

`scripts/localbuild-after-pack.js` (new) is the electron-builder `afterPack`
hook that `npm run localbuild` now points at. `afterPack` runs after the app is
packed and before code signing and installer creation, so it is the one place
that can sign the app in time for it to end up signed inside the DMG. It does
two jobs in order:

1. Run `scripts/set-electron-fuses.js`, the hook that `electron-builder.json`
   registers as `afterPack` for every other build. electron-builder registers
   only one afterPack hook and `--config.afterPack` replaces it, so the local
   build must do that work itself or the Electron fuse hardening (RunAsNode off,
   cookie encryption, NODE_OPTIONS and `--inspect` disabled, asar integrity,
   only load app from asar) would silently disappear from every localbuild.
2. Ad-hoc sign the bundle, unconditionally. The signature is what makes the app
   runnable, and the hook cannot tell whether electron-builder's own signing
   step will actually run afterwards. When it does run, `@electron/osx-sign`
   re-signs every binary it walks with `--force` and its walk covers the whole
   of `Contents`, so it upgrades everything this hook signed and the finished
   app is signed exactly as before this change. When it does not run, the
   ad-hoc signature is what ships.

`scripts/sign-local-macos.js`:

- `findCodeSigningIdentity(output)` extracted from `selectCodeSigningIdentity`.
  Returns the identity or `null`.
- `selectCodeSigningIdentity(output)` keeps its exact previous contract and
  error message.
- `findMachOBinaries(rootDir)` walks a bundle (symlinks skipped) and returns
  files whose first four bytes are a Mach-O magic, including the fat64 pair.
  Fat Mach-O shares its magic with the Java class-file format, so fat candidates
  are only accepted when the next word is a plausible architecture count (1-32),
  which keeps a stray `.class` file out of the codesign sweep.
  A file that cannot be read throws rather than being skipped: it could not be
  signed either, so failing loudly beats shipping unsigned code.
- `runCodesign(args, label)` runs `/usr/bin/codesign` with an argument array and
  throws with codesign's own output on failure, naming the signal when codesign
  is killed rather than exiting.
- `adHocSignApp(appPath, deps)` signs every Mach-O binary in the bundle first
  (so the resource seal covers their final bytes), then the bundle with
  `codesign --force --deep --sign -`, then verifies with
  `codesign --verify --deep --strict`. The sweep covers every Mach-O, including
  any that a later real signing pass would skip: electron-builder's
  `MacTargetHelper.buildSignOptions` hands `@electron/osx-sign` an ignore list
  covering `Contents/PlugIns`, `*.kext` and the puppeteer/playwright browser
  caches, so anything Mach-O in those paths would keep its ad-hoc signature in a
  real build. The installed app holds no Mach-O in any of those (26 Mach-O
  files, 0 ignore-list hits, checked 10 October 2026).
- `sign()` and `signWithLocalIdentity()` are unchanged from before this work.
  An earlier draft of this change gave `sign()` a `deps` parameter; it was
  dropped because electron-builder calls the hook as `customSign(opts, packager)`
  and the packager's own `signApp` method would have been picked up through the
  prototype chain.

`scripts/localbuild.js`: the darwin args gain
`--config.afterPack=scripts/localbuild-after-pack.js`. Windows and Linux args
are unchanged.

Hook resolution: Node's dynamic `import()` of `localbuild-after-pack.js`
exposes `default` as the `afterPack` function and does not set a named
`afterPack` export. `app-builder-lib` `resolveFunction` uses `m.default` when
the named export is missing, which is the same path `set-electron-fuses.js`
already uses.

Signing order in `platformPackager.doPack`: `emitAfterPack`, then
`sanityCheckPackage` (read-only existence checks), then `doAddElectronFuses`
(no-ops because `electron-builder.json` has no `electronFuses` key), then
`doSignAfterPack`. With no identity, `MacPackager.sign()` returns false before
the custom `mac.sign` hook, so the ad-hoc signature from this hook is what
remains inside the DMG. `mac.identity: null` still skips signing entirely and
is not the path `npm run localbuild` uses.

## Verification

- `npx vitest run scripts/__tests__/sign-local-macos.spec.ts
  scripts/__tests__/localbuild-after-pack.spec.ts
  scripts/__tests__/localbuild.spec.ts`: 20 passed (exit 0), re-run by the
  independent review on 10 October 2026.
- Integration probe on a `ditto` copy of `/Applications/Harness.app` under
  `/tmp` (deleted after use). `codesign --force --deep --sign -` alone left
  `better_sqlite3.node` and the darwin-arm64 `pty.node` unsigned ("code object
  is not signed at all"). `adHocSignApp` then reported `Signature=adhoc` on
  both, and `codesign --verify --deep --strict` passed on the bundle. The
  installed app was not modified.
- The installed app contains 26 Mach-O files and none under the electron-builder
  ignore paths.
- Forensic grep of the added lines: no skipped tests, no type or lint
  suppressions, no empty catches, no stubs, no new network calls.
- The repo-wide test suite was not run. The checkout contains a large unrelated
  dirty set, so a full suite would not isolate this change.

## As-built

`npm run localbuild` on a Mac with no certificate produces an ad-hoc signed
arm64 DMG in `release/`. A Mac that does have a certificate still gets the
real signature afterwards, because electron-builder re-signs with `--force`.

James approved the email to Jim on 10 October 2026. It tells him to build with
`npm run localbuild` from `Community-Tech-UK/ai-orchestrator`. That instruction
is true once this commit is on origin/main. Local main was already 3 commits
ahead of origin, so the push that publishes this commit also publishes those.
