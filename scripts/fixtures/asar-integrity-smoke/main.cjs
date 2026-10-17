const { app, BrowserWindow } = require('electron');
const fs = require('original-fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = process.env.AIO_ASAR_SMOKE_ROOT;
const mode = process.env.AIO_ASAR_SMOKE_MODE;
if (!root || !['control', 'swap', 'tamper'].includes(mode)) throw new Error('Invalid smoke fixture');

app.setActivationPolicy('prohibited');
app.dock?.hide();
app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, `profile-${mode}`));
app.setPath('crashDumps', path.join(root, 'crash-dumps'));
const report = (stage, details = {}) => console.log(JSON.stringify({ stage, ...details }));
const windows = [];
const deadline = setTimeout(() => { report('timeout'); app.exit(98); }, 20_000);

async function load(stage) {
  const window = new BrowserWindow({
    show: false, focusable: false, skipTaskbar: true, width: 100, height: 100,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
  });
  windows.push(window);
  window.on('show', () => { report('unexpected-visible-window'); app.exit(97); });
  await window.loadURL(`${pathToFileURL(path.join(__dirname, 'index.html')).href}?stage=${stage}`);
  if (window.isVisible()) throw new Error('Smoke window became visible');
  const content = await window.webContents.executeJavaScript('document.body.dataset.version');
  report(stage, { content, visible: window.isVisible() });
  return content;
}

app.whenReady().then(async () => {
  const Database = require(process.env.AIO_ASAR_SMOKE_SQLITE);
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE smoke (value INTEGER NOT NULL)');
    db.prepare('INSERT INTO smoke VALUES (?)').run(42);
    if (db.prepare('SELECT value FROM smoke').get().value !== 42) throw new Error('SQLite read failed');
  } finally {
    db.close();
  }
  report('ready', { electron: process.versions.electron, sqlite: true });
  const before = await load('before');
  if (before !== 'ORIGINAL') throw new Error('Invalid original archive content');
  await windows[0].webContents.session.clearCache();
  const archive = path.join(process.resourcesPath, 'app.asar');
  if (mode === 'swap') {
    fs.renameSync(path.join(root, 'replacement.asar'), archive);
    report('archive-replaced');
  } else if (mode === 'tamper') {
    // Alter only the disposable fixture's packed HTML, keeping its trusted
    // header unchanged. Integrity enforcement must still reject these bytes.
    const position = Number(process.env.AIO_ASAR_SMOKE_POSITION);
    if (!Number.isSafeInteger(position) || position <= 0) throw new Error('Invalid fixture offset');
    const fd = fs.openSync(archive, 'r+');
    try { fs.writeSync(fd, Buffer.from('MODIFIED'), 0, 8, position); } finally { fs.closeSync(fd); }
    report('archive-modified-in-place');
  }
  const after = await load('after');
  clearTimeout(deadline);
  report('finished', { before, after });
  app.exit(before === 'ORIGINAL' && after === 'ORIGINAL' ? 0 : 20);
}).catch((error) => { report('error', { message: error.message }); app.exit(96); });
