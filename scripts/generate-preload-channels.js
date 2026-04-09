#!/usr/bin/env node
/**
 * IPC Channel Generator
 *
 * Reads domain channel files from packages/contracts/src/channels/
 * and writes a merged IPC_CHANNELS object to src/preload/generated/channels.ts.
 *
 * The preload script imports from the generated file at runtime (avoiding the
 * sandbox restriction — no import from packages/ at runtime, only from src/).
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
const GENERATED_PATH = path.join(ROOT, 'src/preload/generated/channels.ts');

function main() {
  console.log('Generating preload IPC channels from contracts package...\n');

  // Verify source file exists
  if (!fs.existsSync(CONTRACTS_CHANNELS_INDEX_PATH)) {
    console.error('Contracts channels index not found: ' + CONTRACTS_CHANNELS_INDEX_PATH);
    process.exit(1);
  }

  const channelBodyLines = extractContractsChannelBodyLines(CONTRACTS_CHANNELS_INDEX_PATH);
  const channelCount = extractContractsChannelEntries(CONTRACTS_CHANNELS_INDEX_PATH).length;
  console.log('Extracted ' + channelCount + ' channels from contracts package');

  // Write generated file
  const generatedContent = [
    '// AUTO-GENERATED — do not edit manually.',
    '// Source: packages/contracts/src/channels/*.channels.ts',
    '// Regenerate: npm run generate:ipc',
    '',
    'export const IPC_CHANNELS = {',
    ...channelBodyLines,
    '} as const;',
    '',
    'export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(GENERATED_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_PATH, generatedContent, 'utf-8');

  console.log('Wrote ' + channelCount + ' channels to ' + path.relative(ROOT, GENERATED_PATH));
  console.log('Done.\n');
}

main();
