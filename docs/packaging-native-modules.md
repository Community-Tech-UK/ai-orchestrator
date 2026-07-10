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
