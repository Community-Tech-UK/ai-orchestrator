#!/usr/bin/env node
/**
 * IPC Channel Sync Verification Script
 *
 * Verifies that the contracts package, the legacy shim, and preload.ts all
 * expose identical IPC channel sets. The contracts package is the intended
 * source of truth during the migration, but the legacy shim still needs to
 * stay exact while imports are being updated.
 *
 * Usage:
 *   node scripts/verify-ipc-channels.js
 *   npm run verify:ipc
 */

const fs = require('fs');
const path = require('path');
const {
  extractContractsChannelEntries,
  extractIpcObjectChannels,
} = require('./ipc-channel-utils');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD_PATH = path.join(ROOT, 'src/preload/preload.ts');
const IPC_TYPES_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');
const CONTRACTS_INDEX_PATH = path.join(ROOT, 'packages/contracts/src/channels/index.ts');

function indexChannelsByName(channels) {
  return new Map(channels.map((channel) => [channel.name, channel]));
}

function compareAgainstSource({ sourceName, sourceChannels, targetName, targetChannels }) {
  const errors = [];
  const targetByName = indexChannelsByName(targetChannels);

  for (const sourceChannel of sourceChannels) {
    const targetChannel = targetByName.get(sourceChannel.name);

    if (!targetChannel) {
      errors.push(
        `❌ Channel "${sourceChannel.name}" from ${sourceName} is missing in ${targetName}`
      );
      continue;
    }

    if (targetChannel.value !== sourceChannel.value) {
      errors.push(
        `❌ Channel "${sourceChannel.name}" differs between ${sourceName} and ${targetName}:\n` +
        `   ${sourceName}: '${sourceChannel.value}'\n` +
        `   ${targetName}: '${targetChannel.value}'`
      );
    }
  }

  return errors;
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

  if (!fs.existsSync(CONTRACTS_INDEX_PATH)) {
    console.error(`❌ Contracts channels index not found: ${CONTRACTS_INDEX_PATH}`);
    process.exit(1);
  }

  const preloadChannels = extractIpcObjectChannels(PRELOAD_PATH);
  const legacyChannels = extractIpcObjectChannels(IPC_TYPES_PATH);
  const contractsChannels = extractContractsChannelEntries(CONTRACTS_INDEX_PATH);

  console.log(`📁 Contracts channels: ${contractsChannels.length}`);
  console.log(`📁 Legacy shim channels: ${legacyChannels.length}`);
  console.log(`📁 Preload channels: ${preloadChannels.length}\n`);

  const errors = [];
  const warnings = [];

  errors.push(
    ...compareAgainstSource({
      sourceName: 'contracts',
      sourceChannels: contractsChannels,
      targetName: 'legacy shim',
      targetChannels: legacyChannels,
    }),
    ...compareAgainstSource({
      sourceName: 'legacy shim',
      sourceChannels: legacyChannels,
      targetName: 'contracts',
      targetChannels: contractsChannels,
    }),
    ...compareAgainstSource({
      sourceName: 'contracts',
      sourceChannels: contractsChannels,
      targetName: 'preload',
      targetChannels: preloadChannels,
    }),
    ...compareAgainstSource({
      sourceName: 'preload',
      sourceChannels: preloadChannels,
      targetName: 'contracts',
      targetChannels: contractsChannels,
    })
  );

  // Check 3: Look for duplicate values in the contracts source of truth.
  const valueOccurrences = new Map();
  for (const channel of contractsChannels) {
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
    console.log('✅ IPC channels are synchronized across contracts, legacy shim, and preload!\n');

    // Print summary
    console.log('Summary:');
    console.log(`  - ${contractsChannels.length} channels in contracts`);
    console.log(`  - ${legacyChannels.length} channels in legacy shim`);
    console.log(`  - ${preloadChannels.length} channels in preload`);

    process.exit(0);
  } else {
    console.log(`\n❌ Found ${errors.length} synchronization error(s)`);
    console.log('Please update the channel definitions to match.\n');
    process.exit(1);
  }
}

main();
