/**
 * afterPack hook: flip Electron security fuses before packaging.
 *
 * Why: Electron ships with permissive defaults (RunAsNode on, ASAR integrity off,
 * cookie encryption off). This script hardens the packaged binary so the signed
 * DMG is not trivially exploitable via ELECTRON_RUN_AS_NODE or ASAR patching.
 *
 * Called automatically by electron-builder via the "afterPack" hook in
 * electron-builder.json. Not run during development (only applies to packaged
 * binaries inside the staged app bundle).
 *
 * Ref: claude5.md §A1 — HIGH severity finding.
 */
'use strict';

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * @param {import('@electron/packager').AfterPackContext} context
 */
module.exports = async (context) => {
  const { electronPlatformName, appOutDir } = context;

  let executableName;
  if (electronPlatformName === 'darwin') {
    executableName = path.join(
      appOutDir,
      `${context.packager.appInfo.productName}.app`,
      'Contents',
      'MacOS',
      context.packager.appInfo.productName,
    );
  } else if (electronPlatformName === 'linux') {
    executableName = path.join(appOutDir, context.packager.appInfo.productName);
  } else if (electronPlatformName === 'win32') {
    executableName = path.join(appOutDir, `${context.packager.appInfo.productName}.exe`);
  } else {
    console.warn(`[set-electron-fuses] Unsupported platform: ${electronPlatformName} — skipping`);
    return;
  }

  console.log(`[set-electron-fuses] Hardening: ${executableName}`);

  await flipFuses(executableName, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  console.log('[set-electron-fuses] Fuses applied successfully');
};
