#!/usr/bin/env node
/**
 * Downloads the local embedding model into resources/embedding-model/, verified
 * by checksum. The model is a build input rather than a repo file: it is too
 * large for git, and packaging it means the app needs no network at run time.
 *
 * Usage:
 *   node scripts/fetch-embedding-model.js             fail if it cannot be fetched
 *   node scripts/fetch-embedding-model.js --optional  warn instead (development)
 *
 * Without the model the app still runs, using the word-hash fallback.
 */

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('./embedding-model.json');

const optional = process.argv.includes('--optional');
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const targetDir = path.join(__dirname, '..', 'resources', 'embedding-model', manifest.id);

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isCurrent(file) {
  const target = path.join(targetDir, file.to);
  return fs.existsSync(target) && sha256(target) === file.sha256;
}

async function download(file) {
  const { repository, revision } = manifest.source;
  const url = `https://huggingface.co/${repository}/resolve/${revision}/${file.from}`;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${file.from}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== file.sha256) {
    throw new Error(`${file.from}: checksum mismatch, refusing to install it`);
  }
  // Write then rename, so an interrupted download never looks like a model.
  const target = path.join(targetDir, file.to);
  const partial = `${target}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, target);
}

async function main() {
  const missing = manifest.files.filter((file) => !isCurrent(file));
  if (missing.length === 0) {
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of missing) {
    console.log(`[embedding-model] fetching ${file.to}`);
    await download(file);
  }
}

main().catch((error) => {
  const message = `[embedding-model] could not fetch ${manifest.id}: ${error.message}`;
  if (optional) {
    console.warn(`${message}\n[embedding-model] continuing with the word-hash fallback`);
    return;
  }
  console.error(message);
  process.exitCode = 1;
});
