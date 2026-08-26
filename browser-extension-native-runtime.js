"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROWSER_EXTENSION_PUBLIC_KEY = exports.BROWSER_EXTENSION_ID = exports.BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME = exports.BROWSER_EXTENSION_NATIVE_HOST_NAME = void 0;
exports.prepareBrowserExtensionNativeHostRuntime = prepareBrowserExtensionNativeHostRuntime;
exports.removeBrowserExtensionNativeHostRuntime = removeBrowserExtensionNativeHostRuntime;
exports.browserExtensionNativeHostPaths = browserExtensionNativeHostPaths;
exports.browserExtensionNativeHostManifestPath = browserExtensionNativeHostManifestPath;
exports.assertBrowserExtensionNativeHostManifestWritable = assertBrowserExtensionNativeHostManifestWritable;
exports.mayClaimBrowserExtensionNativeHostManifest = mayClaimBrowserExtensionNativeHostManifest;
exports.isBrowserExtensionNativeHostManifestOwned = isBrowserExtensionNativeHostManifestOwned;
exports.inspectForeignBrowserExtensionNativeHost = inspectForeignBrowserExtensionNativeHost;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const windows_native_messaging_registry_1 = require("./windows-native-messaging-registry");
exports.BROWSER_EXTENSION_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway';
exports.BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway_relay';
exports.BROWSER_EXTENSION_ID = 'jbkobgefdoglecnehdhfpgjamiginjfo';
exports.BROWSER_EXTENSION_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo+StOfam7CfQRsUs+A72AlgFLUnfSQXxJefJ1HHVEl5bxwoN4RA+TkUwflMu6BUHp0ZdtYg/g02sn8SB0og2RDLPKYoVfKGFXl07TOPjidiA/F2MxZe3Ck9icG7oSCIl8eff2BaMSUsuZ3YB+Wo712uVS2Rg0gcq5YIpiBWMpYRARG9w0gN+Hvdug7QsSGYfwZ0upyJAZj/wottlOeSD5u0uKfpXCo4esfyZeKAtIOXpNkNE04Fd821WZjOHZj1f9wdHqXFtESrffFEO6x6IMz3/gwnLNm0NDBX3jBh27+v+OapdPVAAmK9ROtTAGkXlH41PCCuntrtcktpimbYuhwIDAQAB';
function prepareBrowserExtensionNativeHostRuntime(options) {
    const hostName = options.hostName ?? exports.BROWSER_EXTENSION_NATIVE_HOST_NAME;
    const paths = browserExtensionNativeHostPaths({
        userDataPath: options.userDataPath,
        chromeNativeMessagingDir: options.chromeNativeMessagingDir,
        hostName,
    });
    const { nativeDir, runtimeConfigPath, wrapperPath, manifestPath } = paths;
    fs.mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
    chmodIfSupported(nativeDir, 0o700);
    const runtimeConfig = {
        socketPath: options.socketPath,
        extensionToken: options.extensionToken,
        updatedAt: options.now?.() ?? Date.now(),
    };
    fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, {
        mode: 0o600,
    });
    chmodIfSupported(runtimeConfigPath, 0o600);
    writeNativeHostWrapper({
        wrapperPath,
        runtimeConfigPath,
        hostCommand: options.hostCommand,
    });
    const chromeNativeMessagingDirWasDefaulted = options.chromeNativeMessagingDir === undefined;
    if (options.claimChromeManifest !== false) {
        fs.mkdirSync(paths.chromeNativeMessagingDir, { recursive: true });
        fs.writeFileSync(manifestPath, `${JSON.stringify({
            name: hostName,
            description: 'Harness Browser Gateway native host',
            path: wrapperPath,
            type: 'stdio',
            allowed_origins: [`chrome-extension://${exports.BROWSER_EXTENSION_ID}/`],
        }, null, 2)}\n`);
        if (options.registerInOS ?? chromeNativeMessagingDirWasDefaulted) {
            assertWindowsRegistrationPathIsSafe(manifestPath);
            const registered = (options.windowsRegistry ?? (0, windows_native_messaging_registry_1.createWindowsNativeMessagingRegistry)())
                .registerHost(hostName, manifestPath);
            if (!registered) {
                throw new Error(`windows_native_messaging_registration_failed:${hostName}`);
            }
        }
    }
    return {
        nativeDir,
        runtimeConfigPath,
        wrapperPath,
        manifestPath,
    };
}
function removeBrowserExtensionNativeHostRuntime(options) {
    const hostName = options.hostName ?? exports.BROWSER_EXTENSION_NATIVE_HOST_NAME;
    const paths = browserExtensionNativeHostPaths({
        userDataPath: options.userDataPath,
        chromeNativeMessagingDir: options.chromeNativeMessagingDir,
        hostName,
    });
    const { nativeDir, manifestPath } = paths;
    const chromeNativeMessagingDirWasDefaulted = options.chromeNativeMessagingDir === undefined;
    try {
        fs.rmSync(paths.runtimeConfigPath, { force: true });
        fs.rmSync(paths.wrapperPath, { force: true });
    }
    catch {
        // Best-effort cleanup; stale files are harmless once the manifest is gone.
    }
    try {
        fs.unlinkSync(manifestPath);
    }
    catch {
        // Already removed.
    }
    if (options.registerInOS ?? chromeNativeMessagingDirWasDefaulted) {
        assertWindowsRegistrationPathIsSafe(manifestPath);
        (options.windowsRegistry ?? (0, windows_native_messaging_registry_1.createWindowsNativeMessagingRegistry)())
            .unregisterHost(hostName);
    }
    return { nativeDir, manifestPath };
}
function browserExtensionNativeHostPaths(options) {
    const hostName = options.hostName ?? exports.BROWSER_EXTENSION_NATIVE_HOST_NAME;
    const nativeDir = path.join(options.userDataPath, 'browser-gateway', 'native-host');
    const chromeNativeMessagingDir = options.chromeNativeMessagingDir ?? defaultChromeNativeMessagingDir();
    const suffix = browserExtensionNativeHostFileSuffix(hostName);
    const wrapperBaseName = suffix
        ? `ai-orchestrator-browser-host-${suffix}`
        : 'ai-orchestrator-browser-host';
    const wrapperFileName = process.platform === 'win32'
        ? `${wrapperBaseName}.cmd`
        : wrapperBaseName;
    return {
        nativeDir,
        chromeNativeMessagingDir,
        runtimeConfigPath: path.join(nativeDir, suffix ? `runtime-${suffix}.json` : 'runtime.json'),
        wrapperPath: path.join(nativeDir, wrapperFileName),
        manifestPath: browserExtensionNativeHostManifestPath(chromeNativeMessagingDir, hostName),
    };
}
function browserExtensionNativeHostManifestPath(chromeNativeMessagingDir = defaultChromeNativeMessagingDir(), hostName = exports.BROWSER_EXTENSION_NATIVE_HOST_NAME) {
    return path.join(chromeNativeMessagingDir, `${hostName}.json`);
}
function assertBrowserExtensionNativeHostManifestWritable(input) {
    if (input.force || !fs.existsSync(input.manifestPath)) {
        return;
    }
    if (isBrowserExtensionNativeHostManifestOwned(input)) {
        return;
    }
    throw new Error(`Refusing to overwrite existing Chrome native host manifest at ${input.manifestPath}; use --force if this machine should use the worker extension relay.`);
}
/**
 * Whether this install may claim the machine's Chrome native-messaging
 * manifest.
 *
 * There is exactly one manifest per Chrome profile, so two Harness installs on
 * one machine compete for it — typically the packaged app and a `npm run dev`
 * app with its own `AIO_DEV_USER_DATA_PATH`. The write is unconditional, so the
 * last starter silently takes the user's local extension channel; and a dev app
 * whose profile is then deleted leaves the manifest pointing at a binary that
 * no longer exists, breaking the local channel until the packaged app restarts.
 *
 * The packaged install therefore always wins — it is the one the user actually
 * uses, and because it rewrites on every start a stale entry self-heals. An
 * unpackaged install only claims a manifest that is absent or already its own,
 * unless the operator opts in explicitly.
 */
function mayClaimBrowserExtensionNativeHostManifest(input) {
    if (input.forceClaim === true || input.isPackaged) {
        return true;
    }
    if (!fs.existsSync(input.manifestPath)) {
        return true;
    }
    return isBrowserExtensionNativeHostManifestOwned(input);
}
function isBrowserExtensionNativeHostManifestOwned(input) {
    if (!fs.existsSync(input.manifestPath)) {
        return false;
    }
    try {
        const raw = fs.readFileSync(input.manifestPath, 'utf-8');
        const manifest = JSON.parse(raw);
        const existingPath = typeof manifest.path === 'string' ? manifest.path : '';
        return existingPath.length > 0 && isPathInsideOrSame(input.nativeDir, existingPath);
    }
    catch {
        return false;
    }
}
/**
 * Inspect a native-host manifest owned by ANOTHER install (e.g. the Harness
 * desktop app vs the worker relay) and decide whether that install is
 * plausibly alive. "Alive" requires the full chain to check out: wrapper
 * exists → wrapper's runtime config parses → the socket/pipe it targets
 * exists (something is listening). Any provably broken link means commands
 * routed through that manifest die at the first hop — the windows-pc outage
 * where Chrome's manifest pointed at a runtime whose named pipe no longer
 * existed. Unknown wrapper formats are conservatively treated as alive: we
 * only take over installs we can PROVE are dead.
 */
function inspectForeignBrowserExtensionNativeHost(manifestPath) {
    let wrapperPath;
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (typeof manifest.path !== 'string' || !manifest.path) {
            return { alive: false, reason: 'manifest_unreadable' };
        }
        wrapperPath = manifest.path;
    }
    catch {
        return { alive: false, reason: 'manifest_unreadable' };
    }
    if (!fs.existsSync(wrapperPath)) {
        return { alive: false, reason: 'wrapper_missing', ownerPath: wrapperPath };
    }
    const runtimeConfigPath = parseWrapperRuntimeConfigPath(wrapperPath);
    if (!runtimeConfigPath) {
        // Not a wrapper we generated — cannot judge it, so treat as alive.
        return { alive: true, reason: 'wrapper_unrecognized', ownerPath: wrapperPath };
    }
    let socketPath;
    try {
        const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8'));
        if (typeof runtimeConfig.socketPath !== 'string' || !runtimeConfig.socketPath) {
            return { alive: false, reason: 'runtime_config_unreadable', ownerPath: wrapperPath };
        }
        socketPath = runtimeConfig.socketPath;
    }
    catch {
        return { alive: false, reason: 'runtime_config_unreadable', ownerPath: wrapperPath };
    }
    // Works for unix sockets and Windows named pipes alike: existsSync on
    // \\.\pipe\<name> reports whether anything is currently listening.
    return fs.existsSync(socketPath)
        ? { alive: true, reason: 'socket_present', ownerPath: wrapperPath }
        : { alive: false, reason: 'socket_missing', ownerPath: wrapperPath };
}
/**
 * Both the Harness app and the worker relay generate wrappers through
 * writeNativeHostWrapper above, so the runtime-config path can be recovered
 * from the AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG assignment in either the
 * cmd (`set VAR=path`) or sh (`VAR='path' \`) flavor.
 */
function parseWrapperRuntimeConfigPath(wrapperPath) {
    let content;
    try {
        content = fs.readFileSync(wrapperPath, 'utf-8');
    }
    catch {
        return undefined;
    }
    for (const line of content.split(/\r?\n/)) {
        const match = /^(?:set\s+)?AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=(.+)$/.exec(line.trim());
        if (!match) {
            continue;
        }
        let value = match[1].trim();
        if (value.endsWith('\\')) {
            value = value.slice(0, -1).trim();
        }
        if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
            value = value.slice(1, -1).replace(/'\\''/g, "'");
        }
        return value || undefined;
    }
    return undefined;
}
function assertWindowsRegistrationPathIsSafe(manifestPath) {
    if (process.platform !== 'win32') {
        return;
    }
    if (!isPathInsideOrSame(os.tmpdir(), manifestPath)) {
        return;
    }
    throw new Error(`Refusing to touch Windows native host registration under temp directory: ${manifestPath}`);
}
function writeNativeHostWrapper(options) {
    const commandArgs = options.hostCommand.args ?? [];
    if (process.platform === 'win32') {
        fs.writeFileSync(options.wrapperPath, [
            '@echo off',
            `set AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=${options.runtimeConfigPath}`,
            [
                quoteCmd(options.hostCommand.exe),
                ...commandArgs.map(quoteCmd),
                '%*',
            ].join(' '),
            '',
        ].join('\r\n'));
        return;
    }
    fs.writeFileSync(options.wrapperPath, [
        '#!/bin/sh',
        `AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=${quoteSh(options.runtimeConfigPath)} \\`,
        [
            'exec',
            quoteSh(options.hostCommand.exe),
            ...commandArgs.map(quoteSh),
            '"$@"',
        ].join(' '),
        '',
    ].join('\n'), { mode: 0o700 });
    chmodIfSupported(options.wrapperPath, 0o700);
}
function defaultChromeNativeMessagingDir() {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
    }
    if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'NativeMessagingHosts');
    }
    return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
}
function chmodIfSupported(targetPath, mode) {
    if (process.platform === 'win32') {
        return;
    }
    fs.chmodSync(targetPath, mode);
}
function browserExtensionNativeHostFileSuffix(hostName) {
    if (hostName === exports.BROWSER_EXTENSION_NATIVE_HOST_NAME) {
        return '';
    }
    const prefix = `${exports.BROWSER_EXTENSION_NATIVE_HOST_NAME}_`;
    const rawSuffix = hostName.startsWith(prefix)
        ? hostName.slice(prefix.length)
        : hostName;
    const suffix = rawSuffix
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return suffix || 'custom';
}
function isPathInsideOrSame(parent, child) {
    const relative = path.relative(resolveNativePath(parent), resolveNativePath(child));
    return (relative === ''
        || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)));
}
function resolveNativePath(targetPath) {
    const resolvedPath = path.resolve(targetPath);
    const missingSegments = [];
    let candidate = resolvedPath;
    while (true) {
        try {
            return path.join(fs.realpathSync.native(candidate), ...missingSegments.reverse());
        }
        catch {
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                return resolvedPath;
            }
            missingSegments.push(path.basename(candidate));
            candidate = parent;
        }
    }
}
function quoteSh(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function quoteCmd(value) {
    return `"${value.replace(/"/g, '""')}"`;
}
//# sourceMappingURL=browser-extension-native-runtime.js.map