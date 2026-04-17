/* eslint-env node */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const PINNED_VERSION = '2.12.0';
const BASE_URL = `https://github.com/winsw/winsw/releases/download/v${PINNED_VERSION}`;
const EXPECTED_SHA256 = {
  'WinSW-x64.exe': 'REPLACE_WITH_ACTUAL_HASH_ON_FIRST_RUN',
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u) =>
      https.get(u, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      });
    doGet(url);
  });
}

async function main() {
  const outDir = path.resolve(__dirname, '..', 'resources', 'winsw');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of Object.keys(EXPECTED_SHA256)) {
    const dest = path.join(outDir, name);
    if (fs.existsSync(dest)) {
      console.log(`[winsw] ${name} already present, skipping`);
      continue;
    }
    console.log(`[winsw] downloading ${name}`);
    await download(`${BASE_URL}/${name}`, dest);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    const expected = EXPECTED_SHA256[name];
    if (expected && expected !== 'REPLACE_WITH_ACTUAL_HASH_ON_FIRST_RUN' && actual !== expected) {
      fs.unlinkSync(dest);
      throw new Error(`SHA256 mismatch for ${name}: expected ${expected}, got ${actual}`);
    }
    console.log(`[winsw] ${name} sha256=${actual}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
