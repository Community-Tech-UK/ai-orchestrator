#!/usr/bin/env node
'use strict';

// electron-builder `afterPack` hook used by `npm run localbuild` on macOS (see
// scripts/localbuild.js). It runs after the app is packed and before code
// signing and installer creation, so anything done here is inside the DMG.
//
// Two jobs, in this order:
//
// 1. Flip the Electron security fuses. That is the work the release build gets
//    from `"afterPack": "scripts/set-electron-fuses.js"` in electron-builder.json,
//    and electron-builder registers only one afterPack hook, so pointing
//    localbuild at this file must not lose that hardening.
//
// 2. Ad-hoc sign the bundle. electron-builder silently skips signing altogether
//    when it decides not to sign (`MacPackager.sign()` returns false before the
//    `mac.sign` hook is ever called, which is what happens on a Mac with no
//    code-signing certificate), and unsigned arm64 code never loads. Signing
//    here guarantees the app in the DMG is signed whatever electron-builder
//    decides afterwards. When a real identity is installed, the signing step
//    that runs next re-signs every binary it walks with that identity
//    (@electron/osx-sign signs with --force), so the finished app is signed
//    exactly as it was before this hook existed.
//
// Order matters: flipping the fuses rewrites the main executable and re-applies
// an ad-hoc signature to it, so any real signature has to be applied afterwards.

const fs = require('node:fs');
const path = require('node:path');
const setElectronFuses = require('./set-electron-fuses.js');
const { adHocSignApp } = require('./sign-local-macos.js');

function findAppBundle(appOutDir) {
  const bundles = fs
    .readdirSync(appOutDir, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory() && candidate.name.endsWith('.app'))
    .map((candidate) => candidate.name)
    .sort();
  if (bundles.length !== 1) {
    throw new Error(`Expected exactly one .app bundle in ${appOutDir}, found ${bundles.length}`);
  }
  return path.join(appOutDir, bundles[0]);
}

async function afterPackImpl(context, deps = {}) {
  const runFuses = deps.setElectronFuses ?? setElectronFuses;
  const adHocSign = deps.adHocSign ?? adHocSignApp;
  const findBundle = deps.findAppBundle ?? findAppBundle;

  await runFuses(context);
  await adHocSign(findBundle(context.appOutDir));
}

async function afterPack(context) {
  return afterPackImpl(context, {});
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.afterPackImpl = afterPackImpl;
module.exports.findAppBundle = findAppBundle;
