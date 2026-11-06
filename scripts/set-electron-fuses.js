/**
 * afterPack hook: flip Electron security fuses before packaging.
 *
 * Why: Electron ships with permissive defaults. This script hardens the
 * packaged binary so the signed DMG is not trivially exploitable via
 * NODE_OPTIONS injection, --inspect flags, ASAR patching, or being abused
 * as a general-purpose Node runtime via `ELECTRON_RUN_AS_NODE=1`.
 *
 * Called automatically by electron-builder via the "afterPack" hook in
 * electron-builder.json. Not run during development (only applies to packaged
 * binaries inside the staged app bundle).
 *
 * Ref: claude5.md §A1 (original hardening finding). RunAsNode was briefly
 * re-enabled (mid-2026) when the 4 stdio MCP integrations were discovered to
 * silently fail in packaged builds — they spawned the AI Orchestrator binary
 * with `ELECTRON_RUN_AS_NODE=1` to host Node-only JS, which the fuse blocked.
 * That regression is now closed by Phase 4–5 of the SEA dispatcher work:
 * `dist/aio-mcp-cli-sea/aio-mcp` ships as `extraResources` (see
 * `electron-builder.json`), all four spawn sites point at it instead of the
 * Electron binary, and the JS forwarders proxy back to in-process RPC
 * servers (no `better-sqlite3` / native modules in the spawned runtime).
 * So `RunAsNode` can — and must — stay `false`.
 */
'use strict';

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/** The binary electron-builder produced, or null for a platform this hook does not harden. */
function packagedExecutablePath({ electronPlatformName, appOutDir, packager }) {
  const { productName } = packager.appInfo;
  switch (electronPlatformName) {
    case 'darwin':
      return path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
    case 'linux':
      // Linux binaries take the lower-cased package name, not the product name.
      return path.join(appOutDir, packager.executableName);
    case 'win32':
      return path.join(appOutDir, `${productName}.exe`);
    default:
      return null;
  }
}

/**
 * @param {import('@electron/packager').AfterPackContext} context
 */
module.exports = async (context) => {
  const { electronPlatformName } = context;
  const executableName = packagedExecutablePath(context);
  if (!executableName) {
    console.warn(`[set-electron-fuses] Unsupported platform: ${electronPlatformName} — skipping`);
    return;
  }

  console.log(`[set-electron-fuses] Hardening: ${executableName}`);

  await flipFuses(executableName, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',

    // RunAsNode stays DISABLED. No spawn path in the app still depends on
    // `ELECTRON_RUN_AS_NODE=1` — the four formerly-affected integrations
    // (orchestrator-tools MCP, codemem MCP, browser-gateway MCP, Chrome
    // native-messaging host) now all dispatch through the `aio-mcp` Node
    // SEA binary (`dist/aio-mcp-cli-sea/aio-mcp`, shipped via the
    // `aio-mcp-cli` extraResources entry in electron-builder.json). The
    // SEA only contains stdio↔Unix-socket forwarders that proxy to
    // OrchestratorToolsRpcServer / CodememRpcServer / BrowserGatewayRpcServer
    // running in the parent process, so it carries no `better-sqlite3`
    // dependency and works under this hardening.
    [FuseV1Options.RunAsNode]: false,

    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  console.log('[set-electron-fuses] Fuses applied successfully');
};

module.exports.packagedExecutablePath = packagedExecutablePath;
