#!/usr/bin/env node
/**
 * IPC Channel Generator
 *
 * Reads IPC_CHANNELS from src/shared/types/ipc.types.ts (the single source
 * of truth) and writes them into src/preload/preload.ts between generation
 * markers. This eliminates manual duplication and channel drift.
 *
 * Usage:
 *   node scripts/generate-preload-channels.js
 *   npm run generate:ipc
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');
const PRELOAD_PATH = path.join(ROOT, 'src/preload/preload.ts');

const START_MARKER = '// --- GENERATED: IPC_CHANNELS START (do not edit manually — run `npm run generate:ipc`) ---';
const END_MARKER = '// --- GENERATED: IPC_CHANNELS END ---';

/**
 * Extract the IPC_CHANNELS object body (everything between { and } as const;)
 * from the shared types file, preserving comments and formatting.
 */
function extractChannelBlock(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let capturing = false;
  let braceDepth = 0;
  const bodyLines = [];

  for (const line of lines) {
    // Detect: export const IPC_CHANNELS = {
    if (!capturing && line.includes('IPC_CHANNELS') && line.includes('{')) {
      capturing = true;
      braceDepth = 1;
      continue;
    }

    if (capturing) {
      // Count braces to handle nested objects (if any future use)
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }

      // If brace depth hit 0, this is the closing line (} as const;)
      if (braceDepth <= 0) {
        break;
      }

      bodyLines.push(line);
    }
  }

  if (bodyLines.length === 0) {
    throw new Error(`Failed to extract IPC_CHANNELS body from ${filePath}`);
  }

  return bodyLines;
}

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
  console.log('⚙️  Generating preload IPC channels from shared types...\n');

  // Verify source file exists
  if (!fs.existsSync(SHARED_PATH)) {
    console.error(`❌ Shared types file not found: ${SHARED_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(PRELOAD_PATH)) {
    console.error(`❌ Preload file not found: ${PRELOAD_PATH}`);
    process.exit(1);
  }

  // Extract channels from shared types
  const channelBodyLines = extractChannelBlock(SHARED_PATH);

  // Count channels for reporting
  const channelPattern = /^\s+([A-Z0-9_]+):\s*['"]([^'"]+)['"]/;
  const channelCount = channelBodyLines.filter(l => channelPattern.test(l)).length;
  console.log(`📁 Extracted ${channelCount} channels from shared types`);

  // Write to preload
  writeToPreload(channelBodyLines);

  console.log(`✅ Wrote ${channelCount} channels to preload.ts`);
  console.log('   (between GENERATED markers)\n');
}

main();
