#!/usr/bin/env node
/**
 * IPC Channel Generator
 *
 * Reads the contract channel definitions from packages/contracts/src/channels/
 * and writes them into src/preload/preload.ts between generation markers.
 * This eliminates manual duplication and channel drift while the legacy
 * src/shared/types/ipc.types.ts shim continues to exist for compatibility.
 *
 * Usage:
 *   node scripts/generate-preload-channels.js
 *   npm run generate:ipc
 */

const fs = require('fs');
const path = require('path');
const {
  extractContractsChannelBodyLines,
  extractContractsChannelEntries,
} = require('./ipc-channel-utils');

const ROOT = path.resolve(__dirname, '..');
const CONTRACTS_CHANNELS_INDEX_PATH = path.join(ROOT, 'packages/contracts/src/channels/index.ts');
const PRELOAD_PATH = path.join(ROOT, 'src/preload/preload.ts');

const START_MARKER = '// --- GENERATED: IPC_CHANNELS START (do not edit manually — run `npm run generate:ipc`) ---';
const END_MARKER = '// --- GENERATED: IPC_CHANNELS END ---';

/**
 * Replace the block between generation markers in preload.ts
 * with the extracted channel definitions.
 */
function writeToPreload(channelBodyLines) {
  const content = fs.readFileSync(PRELOAD_PATH, 'utf-8');

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1) {
    throw new Error(
      `Start marker not found in ${PRELOAD_PATH}.\n` +
      `Expected: ${START_MARKER}\n` +
      `Run Task 1 first to add generation markers.`
    );
  }

  if (endIdx === -1) {
    throw new Error(
      `End marker not found in ${PRELOAD_PATH}.\n` +
      `Expected: ${END_MARKER}`
    );
  }

  // Build the replacement block
  const generatedBlock = [
    START_MARKER,
    'const IPC_CHANNELS = {',
    ...channelBodyLines,
    '} as const;',
    END_MARKER
  ].join('\n');

  // Replace everything from start marker to end marker (inclusive)
  const endOfEndMarker = endIdx + END_MARKER.length;
  const newContent = content.slice(0, startIdx) + generatedBlock + content.slice(endOfEndMarker);

  fs.writeFileSync(PRELOAD_PATH, newContent, 'utf-8');
}

function main() {
  console.log('⚙️  Generating preload IPC channels from contracts package...\n');

  // Verify source file exists
  if (!fs.existsSync(CONTRACTS_CHANNELS_INDEX_PATH)) {
    console.error(`❌ Contracts channels index not found: ${CONTRACTS_CHANNELS_INDEX_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(PRELOAD_PATH)) {
    console.error(`❌ Preload file not found: ${PRELOAD_PATH}`);
    process.exit(1);
  }

  const channelBodyLines = extractContractsChannelBodyLines(CONTRACTS_CHANNELS_INDEX_PATH);
  const channelCount = extractContractsChannelEntries(CONTRACTS_CHANNELS_INDEX_PATH).length;
  console.log(`📁 Extracted ${channelCount} channels from contracts package`);

  // Write to preload
  writeToPreload(channelBodyLines);

  console.log(`✅ Wrote ${channelCount} channels to preload.ts`);
  console.log('   (between GENERATED markers)\n');
}

main();
