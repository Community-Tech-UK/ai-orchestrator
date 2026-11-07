const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
app.setAppPath(root);
const resultPath = path.join(root, '_scratch/worker-auto-update-evidence/dev-result.json');
let finished = false;
const deadline = setTimeout(() => finish({ error: 'App readiness deadline exceeded' }, 1), 90000);
function finish(result, code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  fs.writeFileSync(resultPath, JSON.stringify({ observedAt: new Date().toISOString(), pid: process.pid, profile: app.getPath('userData'), ...result }, null, 2));
  app.quit();
  setTimeout(() => app.exit(code), 8000);
}
app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.webContents.once('did-finish-load', async () => {
    try {
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      let visibilityOverride;
      try {
        await window.webContents.debugger.sendCommand('Emulation.setPageVisibilityOverride', { visibility: 'visible' });
        visibilityOverride = 'accepted';
      } catch (error) { visibilityOverride = error.message; }
      const response = await window.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `(async () => {
          for (let i = 0; i < 100 && !window.electronAPI?.listInstances; i++) await new Promise(r => setTimeout(r, 100));
          const frames = await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
          return { hidden: document.hidden, visibility: document.visibilityState, frames,
            appRoot: !!document.querySelector('app-root'), api: typeof window.electronAPI?.listInstances,
            instances: await window.electronAPI.listInstances() };
        })()`, awaitPromise: true, returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      const result = response.result.value;
      finish({ visibilityOverride, cdp: result }, result.hidden === false && result.frames && result.appRoot && result.api === 'function' ? 0 : 1);
    } catch (error) { finish({ error: error.message }, 1); }
  });
});
require(path.join(root, 'dist/main/main-process-entry.js'));
