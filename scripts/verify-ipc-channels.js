#!/usr/bin/env node
/**
 * IPC Channel Sync Verification Script
 *
 * Verifies BIDIRECTIONAL sync: preload.ts and ipc.types.ts must have
 * identical IPC_CHANNELS. Since preload channels are now generated from
 * shared types, any mismatch means `npm run generate:ipc` wasn't run.
 *
 * Usage:
 *   node scripts/verify-ipc-channels.js
 *   npm run verify:ipc
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD_PATH = path.join(ROOT, 'src/preload/preload.ts');
const IPC_TYPES_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');

function extractChannels(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const channels = [];

  // Match patterns like:   CHANNEL_NAME: 'channel:value',
  const channelPattern = /^\s+([A-Z0-9_]+):\s*['"]([^'"]+)['"]/;

  let inIpcChannels = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of IPC_CHANNELS object
    if (line.includes('IPC_CHANNELS') && line.includes('{')) {
      inIpcChannels = true;
      continue;
    }

    // Detect end of IPC_CHANNELS object (closing brace with optional semicolon)
    if (inIpcChannels && /^}\s*(as const)?;?\s*$/.test(line.trim())) {
      inIpcChannels = false;
      continue;
    }

    if (inIpcChannels) {
      const match = line.match(channelPattern);
      if (match) {
        channels.push({
          name: match[1],
          value: match[2],
          line: i + 1
        });
      }
    }
  }

  return channels;
}

function main() {
  console.log('🔍 Verifying IPC channel synchronization...\n');

  // Check files exist
  if (!fs.existsSync(PRELOAD_PATH)) {
    console.error(`❌ Preload file not found: ${PRELOAD_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(IPC_TYPES_PATH)) {
    console.error(`❌ IPC types file not found: ${IPC_TYPES_PATH}`);
    process.exit(1);
  }

  // Extract channels from both files
  const preloadChannels = extractChannels(PRELOAD_PATH);
  const sharedChannels = extractChannels(IPC_TYPES_PATH);

  console.log(`📁 Preload channels: ${preloadChannels.length}`);
  console.log(`📁 Shared type channels: ${sharedChannels.length}\n`);

  // Build lookup maps
  const preloadByName = new Map(preloadChannels.map(c => [c.name, c]));
  const sharedByName = new Map(sharedChannels.map(c => [c.name, c]));

  const errors = [];
  const warnings = [];

  // Check 1: All preload channels should exist in shared types
  for (const preloadChannel of preloadChannels) {
    const sharedChannel = sharedByName.get(preloadChannel.name);

    if (!sharedChannel) {
      errors.push(
        `❌ Channel "${preloadChannel.name}" (line ${preloadChannel.line} in preload.ts) ` +
        `is not defined in ipc.types.ts`
      );
    } else if (sharedChannel.value !== preloadChannel.value) {
      errors.push(
        `❌ Channel "${preloadChannel.name}" has different values:\n` +
        `   Preload (line ${preloadChannel.line}): '${preloadChannel.value}'\n` +
        `   Shared (line ${sharedChannel.line}):  '${sharedChannel.value}'`
      );
    }
  }

  // Check 2: All shared channels must exist in preload (bidirectional sync)
  // Since channels are now generated, any mismatch means the generator wasn't run.
  const missingInPreload = [];
  for (const sharedChannel of sharedChannels) {
    if (!preloadByName.has(sharedChannel.name)) {
      missingInPreload.push(sharedChannel);
    }
  }

  if (missingInPreload.length > 0) {
    errors.push(
      `❌ ${missingInPreload.length} channel(s) in ipc.types.ts are missing from preload.ts.\n` +
      `   Run \`npm run generate:ipc\` to regenerate.\n` +
      `   Missing: ${missingInPreload.slice(0, 10).map(c => c.name).join(', ')}` +
      (missingInPreload.length > 10 ? ` ... and ${missingInPreload.length - 10} more` : '')
    );
  }

  // Check 3: Look for duplicate values
  const valueOccurrences = new Map();
  for (const channel of [...preloadChannels, ...sharedChannels]) {
    const existing = valueOccurrences.get(channel.value) || [];
    existing.push(channel);
    valueOccurrences.set(channel.value, existing);
  }

  for (const [value, channels] of valueOccurrences) {
    const uniqueNames = new Set(channels.map(c => c.name));
    if (uniqueNames.size > 1) {
      warnings.push(
        `⚠️  Channel value '${value}' is used by multiple names: ` +
        `${Array.from(uniqueNames).join(', ')}`
      );
    }
  }

  // Report results
  if (errors.length > 0) {
    console.log('ERRORS:\n');
    errors.forEach(e => console.log(e + '\n'));
  }

  if (warnings.length > 0) {
    console.log('WARNINGS:\n');
    warnings.forEach(w => console.log(w + '\n'));
  }

  if (errors.length === 0) {
    console.log('✅ IPC channels are synchronized (bidirectional)!\n');

    // Print summary
    console.log('Summary:');
    console.log(`  - ${sharedChannels.length} channels in shared types`);
    console.log(`  - ${preloadChannels.length} channels in preload`);

    if (preloadChannels.length !== sharedChannels.length) {
      console.log(`  ⚠️  Count mismatch (${sharedChannels.length} vs ${preloadChannels.length}) — channel names match but counts differ`);
    }

    process.exit(0);
  } else {
    console.log(`\n❌ Found ${errors.length} synchronization error(s)`);
    console.log('Please update the channel definitions to match.\n');
    process.exit(1);
  }
}

main();
