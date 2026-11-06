const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const assert = require('node:assert/strict');

const root = process.cwd();
const extension = process.argv[2] || 'cjs';
const archiveMode = process.argv[3] === 'asar';
const compiled = (file) => path.join(root, 'dist', file);
(async () => {
  const fixture = await fs.mkdtemp(path.join(tmpdir(), 'aio-provider-package-proof-'));
  const home = path.join(fixture, 'home');
  const work = path.join(home, 'project');
  const source = path.join(fixture, 'source');
  const pluginRoot = path.join(home, '.orchestrator', 'plugins');
  const report = { runtime: 'compiled main-process implementation and compiled worker host', fixtureOnly: true };
  let manager;
  let packagedHost;
  try {
    await fs.mkdir(work, { recursive: true });
    await fs.mkdir(path.join(source, '.codex-plugin'), { recursive: true });
    await fs.writeFile(path.join(source, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'Provider Proof', version: '1.0.0', slot: 'provider', isolation: 'worker',
    }));
    await fs.writeFile(path.join(source, 'index.' + extension), `
${extension === 'mjs' ? 'export default' : 'module.exports ='} {
  slot: 'provider',
  create: async (ctx) => {
    const fs = await import('node:fs');
    const capabilities = { interruption: false, permissionPrompts: false, sessionResume: false, streamingOutput: true, usageReporting: false, subAgents: false };
    ctx.providerAdapters.registerProviderAdapterFactory('factory:proof', (config) => {
      const listeners = new Set();
      let running = false, sessionId = '', instanceId = '';
      return {
        provider: 'plugin:proof', capabilities,
        events$: { subscribe: (observer) => { listeners.add(observer); return { unsubscribe: () => listeners.delete(observer) }; } },
        getCapabilities: () => ({ toolExecution: false, streaming: true, multiTurn: true, vision: false, fileAttachments: false, functionCalling: false, builtInCodeTools: false }),
        checkStatus: async () => ({ type: 'plugin:proof', available: true, authenticated: true }),
        initialize: async (options) => { running = true; sessionId = options.sessionId || 'proof-session'; instanceId = options.instanceId; },
        sendMessage: async (message) => {
          fs.writeFileSync(ctx.homeDir + '/started.txt', 'started');
          await new Promise((resolve) => setTimeout(resolve, 150));
          const envelope = { eventId: '00000000-0000-4000-8000-000000000001', seq: 0, timestamp: Date.now(), provider: 'plugin:proof', instanceId, sessionId, event: { kind: 'output', messageType: 'assistant', messageId: 'proof-answer', content: 'Proof response: ' + message } };
          for (const observer of listeners) { observer.next(envelope); observer.next({ ...envelope, seq: 1, event: { kind: 'complete' } }); }
        },
        terminate: async () => { running = false; fs.writeFileSync(ctx.homeDir + '/terminated.txt', 'terminated'); }, getUsage: () => null,
        getPid: () => null, isRunning: () => running, getSessionId: () => sessionId,
      };
    });
    ctx.providerAdapters.registerProviderAdapter({ provider: 'plugin:proof', displayName: 'Provider Proof', capabilities, defaultConfig: { type: 'plugin:proof', name: 'Provider Proof', enabled: true }, isolation: 'worker' }, 'factory:proof');
    return { provider: 'plugin:proof' };
  }
};
`);

    // Only the Electron host APIs/settings are replaced, so this cannot open a
    // window or write to the real Harness profile. Package/worker/registry code
    // below is the compiled production code, without implementation doubles.
    const app = Object.assign(new EventEmitter(), {
      getPath: (name) => name === 'home' ? home : path.join(fixture, name),
      getAppPath: () => path.resolve('.'), getVersion: () => '0.0.0', getName: () => 'Harness runtime proof', isPackaged: false,
    });
    const handlers = new Map();
    const electron = { app, ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) }, powerMonitor: new EventEmitter(), net: { fetch: global.fetch } };
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return electron;
      return originalLoad.call(this, request, parent, isMain);
    };
    require(compiled('main/register-aliases.js'));
    const injectModule = (relative, exports) => {
      const file = require.resolve(compiled(relative));
      require.cache[file] = { id: file, filename: file, loaded: true, exports };
    };
    injectModule('main/core/config/settings-manager.js', { getSettingsManager: () => ({ getAll: () => ({ agents: {}, appearance: {}, projectPluginTrust: {} }), get: () => undefined }) });
    const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } };
    injectModule('main/logging/logger.js', { getLogger: () => logger });

    const { OrchestratorPluginManager } = require(compiled('main/plugins/plugin-manager.js'));
    const { PluginPackageManager } = require(compiled('main/plugins/plugin-package-manager.js'));
    const { providerAdapterRegistry } = require(compiled('main/providers/provider-adapter-registry.js'));
    const { ProviderInstanceManager } = require(compiled('main/providers/provider-instance-manager.js'));
    const { InstanceCreatePayloadSchema } = require(compiled('packages/contracts/src/schemas/instance.schemas.js'));
    manager = OrchestratorPluginManager.getInstance();
    const packages = new PluginPackageManager({ pluginRoot, storePath: path.join(fixture, 'installs.json') });
    const installed = await packages.install({ type: 'directory', value: source });
    report.installStatus = installed.status;
    assert.equal(installed.status, 'installed');
    const loaded = await manager.listPlugins(work, {});
    const plugin = loaded.plugins.find((item) => item.manifest?.name === 'Provider Proof');
    assert(plugin, 'Installed package was not discovered');
    report.pluginLifecycle = plugin.lifecycle;
    report.pluginLoadReport = plugin.loadReport;
    report.errors = loaded.errors;
    report.registeredProviders = providerAdapterRegistry.listCreatablePluginProviderAdapters().map((item) => item.descriptor.provider);
    const providers = new ProviderInstanceManager();
    report.providerListIncludesPackage = providers.getAllConfigs().some((item) => item.type === 'plugin:proof');
    const normalSession = InstanceCreatePayloadSchema.safeParse({ workingDirectory: work, provider: 'plugin:proof' });
    report.normalSessionCreateAccepted = normalSession.success;
    report.normalSessionCreateErrors = normalSession.success ? [] : normalSession.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));

    assert.equal(report.providerListIncludesPackage, true);
    assert.equal(plugin.lifecycle, 'active');
    assert.equal(plugin.loadReport.ready, true);
    const { registerRuntimeProviderSessionHandlers } = require(compiled('main/ipc/handlers/runtime-provider-session-handlers.js'));
    const { createRuntimePluginDomain } = require(compiled('preload/domains/runtime-plugin.preload.js'));
    const { IPC_CHANNELS } = require(compiled('preload/generated/channels.js'));
    registerRuntimeProviderSessionHandlers({ instanceManager: {}, ensureTrustedSender: () => null });
    const api = createRuntimePluginDomain({ invoke: (channel, payload) => handlers.get(channel)({}, payload) }, IPC_CHANNELS);
    const listed = await api.runtimeProviderList(work);
    assert.equal(listed.success, true);
    assert.equal(listed.data.providers[0].provider, 'plugin:proof');
    const pendingReply = api.runtimeProviderSend({ workingDirectory: work, provider: 'plugin:proof', message: 'hello' });
    const started = path.join(home, 'started.txt');
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await fs.access(started); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await fs.access(started);
    // A normal hook dispatch refreshes the plugin cache after ten seconds.
    // Advance only the cache's wall clock; do not wait or stress the machine.
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 20000;
      await manager.listPlugins(work, {});
    } finally { Date.now = originalNow; }
    const reply = await pendingReply;
    assert.equal(reply.success, true, JSON.stringify(reply));
    assert.equal(reply.data.content, 'Proof response: hello');
    report.reply = reply.data.content;
    assert.equal(await fs.readFile(path.join(home, 'terminated.txt'), 'utf8'), 'terminated');
    // Only these emitted runtime modules are copied, below this worktree. There
    // are no repository sources at the SDK path the packaged host resolves.
    const packaged = await fs.mkdtemp(path.join(root, '_scratch', 'provider-packaged-'));
    report.packagedRoot = packaged;
    const files = ['main/plugins/plugin-worker-host.js', 'main/plugins/plugin-worker-module.js', 'packages/sdk/src/provider-adapter-worker-bridge.js'];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(packaged, file)), { recursive: true });
      await fs.copyFile(compiled(file), path.join(packaged, file));
    }
    let shippedRoot = packaged;
    if (archiveMode) {
      await require('@electron/asar').createPackage(packaged, packaged + '.asar');
      report.archiveFile = packaged + '.asar';
      shippedRoot = report.archiveFile;
    }
    const { PluginWorkerHost } = require(path.join(shippedRoot, 'main/plugins/plugin-worker-host.js'));
    packagedHost = new PluginWorkerHost({ filePath: path.join(installed.installPath, 'index.' + extension), context: { appPath: packaged, homeDir: home }, requestedSlot: 'provider', providerAdapterApi: { registerProviderAdapter() {} } });
    const packagedRuntime = await packagedHost.start();
    assert.equal(packagedRuntime.ready, true);
    assert.equal(packagedRuntime.providerAdapters[0].descriptor.provider, 'plugin:proof');
    await packagedHost.stop(); packagedHost = null;
    if (report.archiveFile) { await require('original-fs').promises.unlink(report.archiveFile); delete report.archiveFile; }
    await fs.rm(packaged, { recursive: true, force: true });
    delete report.packagedRoot;
    report.sourceFreeWorker = true;
    await packages.uninstall(installed.id);
    report.afterUninstallProviders = providerAdapterRegistry.listCreatablePluginProviderAdapters().map((item) => item.descriptor.provider);
    assert.deepEqual(report.afterUninstallProviders, []);

    await fs.writeFile(path.join(source, 'index.' + extension), `${extension === 'mjs' ? 'export default' : 'module.exports ='} { create: () => ({}) };`);
    await packages.install({ type: 'directory', value: source });
    const failed = await manager.listPlugins(work, {});
    const invalid = failed.plugins.find((item) => item.manifest?.name === 'Provider Proof');
    assert.equal(invalid.lifecycle, 'failed');
    assert.equal(invalid.loadReport.ready, false);
    assert.match(invalid.loadReport.error, /must register at least one provider adapter/);
    assert.deepEqual(providerAdapterRegistry.listCreatablePluginProviderAdapters(), []);
    await packages.uninstall(installed.id);
    report.invalidPackageRejected = true;
    console.log(JSON.stringify({ installed: report.installStatus, lifecycle: report.pluginLifecycle, reply: report.reply, normalSessionAccepted: report.normalSessionCreateAccepted, sourceFreeWorker: report.sourceFreeWorker, invalidPackageRejected: true, survivedCacheRefresh: true, cleaned: true }));
  } finally {
    await packagedHost?.stop();
    manager?.clearCache();
    if (report.archiveFile) await require('original-fs').promises.unlink(report.archiveFile);
    if (report.packagedRoot) await fs.rm(report.packagedRoot, { recursive: true, force: true });
    await fs.rm(fixture, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
