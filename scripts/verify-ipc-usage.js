#!/usr/bin/env node
/**
 * Warn-level IPC lifecycle scanner.
 *
 * `verify-ipc-channels.js` checks generated channel synchronization. This
 * script checks the next layer: whether contract channel constants appear to
 * have a main-process handler/emitter, a preload exposure, and a renderer/main
 * consumer. Some channels are event-only or intentionally internal, so this is
 * report-only by default. Set AIO_VERIFY_IPC_USAGE_STRICT=1 to fail on findings
 * once the allowlist has been ratcheted.
 */

const fs = require('node:fs');
const path = require('node:path');
const { extractContractsChannelEntries } = require('./ipc-channel-utils');

const ROOT = path.resolve(__dirname, '..');
const CONTRACTS_INDEX_PATH = path.join(ROOT, 'packages/contracts/src/channels/index.ts');

function listFiles(dir, opts = {}) {
  const { exts = ['.ts', '.tsx'], exclude = [] } = opts;
  const out = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (exclude.some((fragment) => full.includes(fragment))) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.worktrees') {
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function blobs(files) {
  return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

function anyIncludes(items, needle) {
  return items.some((item) => item.text.includes(needle));
}

function filesIncluding(items, needle) {
  return items
    .filter((item) => item.text.includes(needle))
    .map((item) => path.relative(ROOT, item.file));
}

function findPreloadKeys(preloadBlobs, channelName) {
  const keys = [];
  const usageRe = new RegExp(`\\bch\\.${channelName}\\b`, 'g');
  const keyLineRe = /(?:^|\n)\s*([A-Za-z0-9_]+)\s*:\s*/g;
  for (const blob of preloadBlobs) {
    let match;
    while ((match = usageRe.exec(blob.text)) !== null) {
      const before = blob.text.slice(Math.max(0, match.index - 400), match.index);
      let keyMatch;
      let lastKey = null;
      while ((keyMatch = keyLineRe.exec(before)) !== null) {
        lastKey = keyMatch[1];
      }
      if (lastKey) keys.push(lastKey);
    }
  }
  return [...new Set(keys)];
}

function scanIpcUsage() {
  const channels = extractContractsChannelEntries(CONTRACTS_INDEX_PATH);
  const handlerBlobs = blobs(listFiles(path.join(ROOT, 'src/main/ipc'), {
    exclude: ['.spec.ts', '__tests__'],
  }));
  const allMainBlobs = blobs(listFiles(path.join(ROOT, 'src/main'), {
    exclude: ['.spec.ts', '__tests__'],
  }));
  const preloadBlobs = blobs(listFiles(path.join(ROOT, 'src/preload'), {
    exclude: ['.spec.ts', '__tests__', 'generated/channels.ts'],
  }));
  const consumerBlobs = blobs([
    ...listFiles(path.join(ROOT, 'src/renderer'), { exclude: ['.spec.ts', '__tests__'] }),
    ...listFiles(path.join(ROOT, 'src/main'), { exclude: ['.spec.ts', '__tests__', 'src/main/ipc'] }),
  ]);

  return channels.map((channel) => {
    const literalSingle = `'${channel.value}'`;
    const literalDouble = `"${channel.value}"`;
    const handlerHit =
      anyIncludes(handlerBlobs, channel.name) ||
      anyIncludes(handlerBlobs, literalSingle) ||
      anyIncludes(handlerBlobs, literalDouble);
    const mainHit =
      handlerHit ||
      anyIncludes(allMainBlobs, channel.name) ||
      anyIncludes(allMainBlobs, literalSingle) ||
      anyIncludes(allMainBlobs, literalDouble);
    const preloadHit = anyIncludes(preloadBlobs, channel.name);
    const preloadKeys = findPreloadKeys(preloadBlobs, channel.name);
    const consumerFiles = [
      ...new Set(preloadKeys.flatMap((key) => [
        ...filesIncluding(consumerBlobs, `.${key}(`),
        ...filesIncluding(consumerBlobs, `.${key},`),
        ...filesIncluding(consumerBlobs, `.${key};`),
      ])),
    ];
    return {
      ...channel,
      handlerHit,
      mainHit,
      preloadHit,
      preloadKeys,
      consumerHit: consumerFiles.length > 0,
      consumerFiles,
    };
  });
}

function printList(title, rows, max = 50) {
  console.log(`\n${title}: ${rows.length}`);
  for (const row of rows.slice(0, max)) {
    console.log(`  ${row.name} = '${row.value}' keys=[${row.preloadKeys.join(',')}]`);
  }
  if (rows.length > max) {
    console.log(`  ...${rows.length - max} more`);
  }
}

function main() {
  const results = scanIpcUsage();
  const noMainHit = results.filter((row) => !row.mainHit);
  const noPreload = results.filter((row) => !row.preloadHit);
  const exposedNoConsumer = results.filter(
    (row) => row.preloadHit && row.preloadKeys.length > 0 && !row.consumerHit,
  );

  console.log(`verify:ipc-usage — scanned ${results.length} contract channels`);
  printList('No main-process handler/emitter reference', noMainHit);
  printList('No preload exposure reference', noPreload);
  printList('Preload-exposed but no consumer reference found', exposedNoConsumer);

  const findingCount = noMainHit.length + noPreload.length + exposedNoConsumer.length;
  if (findingCount > 0) {
    console.log('\nverify:ipc-usage is warn-level by default. Set AIO_VERIFY_IPC_USAGE_STRICT=1 to fail.');
  }
  if (findingCount > 0 && process.env.AIO_VERIFY_IPC_USAGE_STRICT === '1') {
    process.exit(1);
  }
}

module.exports = { scanIpcUsage };

if (require.main === module) {
  main();
}
