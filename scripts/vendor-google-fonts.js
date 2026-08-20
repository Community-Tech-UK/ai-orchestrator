/* eslint-env node */
/**
 * Vendors the renderer's webfonts from Google Fonts into the repo.
 *
 * The renderer used to `@import url('https://fonts.googleapis.com/...')` from
 * `src/renderer/styles/_theme.scss`. That made a production build fail whenever
 * fonts.googleapis.com was unreachable (Angular's font inliner fetches the
 * stylesheet at build time), and it made the packaged desktop app fetch ~48
 * woff2 subsets from fonts.gstatic.com at runtime — so the UI lost its
 * typography offline and phoned Google on every cold start.
 *
 * This script downloads the woff2 subsets once and generates
 * `src/renderer/styles/_fonts.scss`. Both the fonts and the generated partial
 * are committed; the build no longer touches the network for fonts.
 *
 * Re-run only to pick up a new upstream font version:
 *   node scripts/vendor-google-fonts.js
 *
 * The generated partial is a build input. Do not hand-edit it; change the
 * request below and re-run.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

// Mirrors the families/weights the design system actually uses (see the
// typography tokens in _theme.scss). Keep in sync with --font-mono/--font-sans.
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';

// Google serves woff2 only to user agents it recognises as supporting it.
// A bare curl/node UA gets legacy ttf, which would bloat the bundle ~4x.
const WOFF2_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const STYLES_DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'styles');
const FONTS_DIR = path.join(STYLES_DIR, 'fonts');
const PARTIAL_PATH = path.join(STYLES_DIR, '_fonts.scss');

// Both families are SIL Open Font License 1.1, which requires the copyright
// notice and licence text to travel with every redistributed copy. Vendoring
// the fonts without these would put the repo out of compliance, so they are
// re-fetched from upstream alongside the fonts rather than pasted once and
// left to rot. The hand-written LICENSE.md beside them is NOT generated.
const LICENSES = {
  'OFL-JetBrainsMono.txt': 'https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt',
  'OFL-IBMPlexSans.txt': 'https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt',
};

/**
 * Fetches with a couple of retries. Observed in practice: one run of this
 * script died on a transient TLS/connect error to fonts.gstatic.com midway
 * through the 12 downloads. Failing the whole vendoring run over a blip is
 * needless, and a half-written font directory is worse than either outcome.
 */
async function fetchWithRetry(url, headers = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchUrl(url, headers);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        console.warn(`[fonts] attempt ${attempt} failed for ${url} (${err.message}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
}

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const doGet = (target, redirectsLeft) => {
      https
        .get(target, { headers }, (res) => {
          const { statusCode, location } = res;
          if ((statusCode === 301 || statusCode === 302) && location) {
            res.resume();
            if (redirectsLeft === 0) {
              reject(new Error(`Too many redirects for ${url}`));
              return;
            }
            doGet(new URL(location, target).toString(), redirectsLeft - 1);
            return;
          }
          if (statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${statusCode} for ${target}`));
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('error', reject);
    };
    doGet(url, 5);
  });
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parses the `@font-face` blocks Google returns. Each block is preceded by a
 * `/* subset *\/` comment that names the unicode subset, which we reuse to give
 * the downloaded file a stable, readable name.
 */
function parseFaces(css) {
  const faces = [];
  const blockPattern = /\/\*\s*([^*]+?)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  let match;
  while ((match = blockPattern.exec(css)) !== null) {
    const [, subset, body] = match;
    const read = (property) => {
      const found = new RegExp(`${property}:\\s*([^;]+);`).exec(body);
      return found ? found[1].trim() : undefined;
    };
    const url = /src:\s*url\(([^)]+)\)/.exec(body);
    const family = read('font-family');
    const weight = read('font-weight');
    if (!url || !family || !weight) {
      throw new Error(`Unparsable @font-face block: ${body}`);
    }
    faces.push({
      subset,
      family: family.replace(/['"]/g, ''),
      style: read('font-style') ?? 'normal',
      weight,
      stretch: read('font-stretch'),
      display: read('font-display') ?? 'swap',
      unicodeRange: read('unicode-range'),
      url: url[1].replace(/['"]/g, ''),
    });
  }
  return faces;
}

function renderPartial(faces) {
  const header = [
    '// GENERATED FILE - DO NOT EDIT.',
    '// Regenerate with: node scripts/vendor-google-fonts.js',
    '//',
    '// Self-hosted webfaces for the renderer. These replace a build-time',
    '// @import of fonts.googleapis.com, which broke production builds whenever',
    '// Google was unreachable and left the packaged app fetching fonts from',
    '// fonts.gstatic.com on every launch.',
    '//',
    '// Subsets carry their original unicode-range, so a browser still downloads',
    '// only the faces it actually needs to render the text on screen.',
    '',
  ].join('\n');

  const blocks = faces.map((face) => {
    const lines = [
      `/* ${face.family} ${face.weight} - ${face.subset} */`,
      '@font-face {',
      `  font-family: '${face.family}';`,
      `  font-style: ${face.style};`,
      `  font-weight: ${face.weight};`,
    ];
    if (face.stretch) {
      lines.push(`  font-stretch: ${face.stretch};`);
    }
    lines.push(
      `  font-display: ${face.display};`,
      `  src: url('./fonts/${face.file}') format('woff2');`,
    );
    if (face.unicodeRange) {
      lines.push(`  unicode-range: ${face.unicodeRange};`);
    }
    lines.push('}');
    return lines.join('\n');
  });

  return `${header}\n${blocks.join('\n\n')}\n`;
}

async function main() {
  console.log('[fonts] fetching face definitions');
  const css = (await fetchWithRetry(CSS_URL, { 'User-Agent': WOFF2_UA })).toString('utf8');
  const faces = parseFaces(css);
  if (faces.length === 0) {
    throw new Error('No @font-face blocks parsed - has the Google Fonts CSS format changed?');
  }
  const nonWoff2 = faces.filter((face) => !face.url.endsWith('.woff2'));
  if (nonWoff2.length > 0) {
    throw new Error(`Expected woff2 for every face, got ${nonWoff2[0].url}`);
  }

  // Clear only the payloads this script owns. Wiping the whole directory would
  // take the hand-written LICENSE.md with it, silently dropping the attribution
  // the OFL requires.
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  for (const stale of fs.readdirSync(FONTS_DIR)) {
    if (stale.endsWith('.woff2')) {
      fs.rmSync(path.join(FONTS_DIR, stale));
    }
  }

  // Both families are variable fonts, so Google serves one file per subset and
  // points every requested weight at it. Downloading per weight would store the
  // same bytes four times over. Deduplicate on content hash and keep all 48
  // face declarations, which preserves upstream rendering exactly.
  const fileByDigest = new Map();
  const digestByFile = new Map();
  let totalBytes = 0;
  for (const face of faces) {
    const data = await fetchWithRetry(face.url, { 'User-Agent': WOFF2_UA });
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    const existing = fileByDigest.get(digest);
    if (existing) {
      face.file = existing;
      continue;
    }
    const file = `${slugify(face.family)}-${slugify(face.subset)}.woff2`;
    // If upstream ever ships static instances instead, distinct payloads would
    // collide on this name and silently overwrite each other. Fail loudly so
    // the naming scheme gets revisited rather than shipping missing weights.
    if (digestByFile.has(file)) {
      throw new Error(
        `${file} would be written twice with different content - upstream is no longer serving one variable font per subset`,
      );
    }
    face.file = file;
    fileByDigest.set(digest, file);
    digestByFile.set(file, digest);
    fs.writeFileSync(path.join(FONTS_DIR, file), data);
    totalBytes += data.length;
    console.log(`[fonts] ${file} ${data.length}B sha256:${digest.slice(0, 12)}`);
  }

  for (const [name, url] of Object.entries(LICENSES)) {
    const text = (await fetchWithRetry(url)).toString('utf8');
    if (!text.includes('SIL Open Font License')) {
      throw new Error(`${url} no longer looks like an OFL licence - check upstream before shipping`);
    }
    fs.writeFileSync(path.join(FONTS_DIR, name), text, 'utf8');
    console.log(`[fonts] ${name} (${text.split('\n').length} lines)`);
  }

  fs.writeFileSync(PARTIAL_PATH, renderPartial(faces), 'utf8');
  console.log(
    `[fonts] wrote ${faces.length} faces (${(totalBytes / 1024).toFixed(0)} kB) and ${path.relative(process.cwd(), PARTIAL_PATH)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
