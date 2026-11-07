const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = process.cwd();
const output = path.join(root, '_scratch/worker-auto-update-round2');
const profile = '/tmp/aio-lt-queue-d4bee785';
if (fs.existsSync(profile) && process.env.AIO_LT_REUSE_OWN_PROFILE !== '1') throw new Error('Reserved test profile already exists; refusing to reuse unknown state');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ remoteNodesEnabled: false, thinClientWsEnabled: false, mobileGatewayEnabled: false }));
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const base = path.join(root, 'dist/renderer/browser');
  let file = path.join(base, decodeURIComponent(url.pathname));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(base, 'index.html');
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => {
  const log = fs.openSync(path.join(output, 'dev-stdout.log'), 'w');
  const child = spawn(require('electron'), [path.join(output, 'dev-smoke.cjs'), '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9767', '--js-flags=--max-old-space-size=8192'], {
    cwd: root, env: { ...process.env, AIO_DEV_USER_DATA_PATH: profile, PORT: String(server.address().port) }, stdio: ['ignore', log, log], detached: true,
  });
  fs.closeSync(log);
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGTERM'); }, 110000);
  child.on('error', error => { console.error(error.message); server.close(); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    clearTimeout(deadline);
    let groupAlive = false;
    try { process.kill(-child.pid, 0); groupAlive = true; process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const result = { observedAt: new Date().toISOString(), pid: child.pid, code, signal, timedOut, residualGroupSignalled: groupAlive };
    fs.writeFileSync(path.join(output, 'dev-exit.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    server.close();
    const assertionPath = path.join(output, 'dev-result.json');
    const assertion = fs.existsSync(assertionPath) ? JSON.parse(fs.readFileSync(assertionPath, 'utf8')) : null;
    process.exitCode = code === 0 && !timedOut && assertion?.cdp && !assertion.error ? 0 : 1;
  });
});
