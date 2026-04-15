#!/usr/bin/env node
/**
 * IPC Channel Sync Verification Script
 *
 * Verifies that:
 * 1. src/preload/generated/channels.ts matches packages/contracts channel files
 * 2. The legacy src/shared/types/ipc.types.ts shim either re-exports contracts
 *    directly or stays in sync with contracts during migration
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
const GENERATED_PATH = path.join(ROOT, 'src/preload/generated/channels.ts');
const IPC_TYPES_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');
const CONTRACTS_INDEX_PATH = path.join(ROOT, 'packages/contracts/src/channels/index.ts');

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function legacyShimReExportsContracts(filePath) {
  const content = readFile(filePath);

  return {
    channels: /export\s+\{\s*IPC_CHANNELS\s*\}\s+from\s+['"]@contracts\/channels['"];?/.test(
      content
    ),
    types: /export\s+type\s+\*\s+from\s+['"]@contracts\/types['"];?/.test(content),
  };
}

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
        'Channel "' + sourceChannel.name + '" from ' + sourceName + ' is missing in ' + targetName
      );
      continue;
    }

    if (targetChannel.value !== sourceChannel.value) {
      errors.push(
        'Channel "' + sourceChannel.name + '" differs between ' + sourceName + ' and ' + targetName + ':\n' +
        '   ' + sourceName + ': \'' + sourceChannel.value + '\'\n' +
        '   ' + targetName + ': \'' + targetChannel.value + '\''
      );
    }
  }

  return errors;
}

function main() {
  console.log('Verifying IPC channel synchronization...\n');

  if (!fs.existsSync(GENERATED_PATH)) {
    console.error('Generated channels file not found: ' + GENERATED_PATH);
    console.error('Run `npm run generate:ipc` first.');
    process.exit(1);
  }

  if (!fs.existsSync(IPC_TYPES_PATH)) {
    console.error('IPC types file not found: ' + IPC_TYPES_PATH);
    process.exit(1);
  }

  if (!fs.existsSync(CONTRACTS_INDEX_PATH)) {
    console.error('Contracts channels index not found: ' + CONTRACTS_INDEX_PATH);
    process.exit(1);
  }

  const contractsChannels = extractContractsChannelEntries(CONTRACTS_INDEX_PATH);
  const generatedChannels = extractIpcObjectChannels(GENERATED_PATH);
  const legacyShim = legacyShimReExportsContracts(IPC_TYPES_PATH);
  const legacyChannels = legacyShim.channels
    ? contractsChannels
    : extractIpcObjectChannels(IPC_TYPES_PATH);

  console.log('Generated channels: ' + generatedChannels.length);
  console.log('Legacy shim channels: ' + legacyChannels.length);
  console.log('Contracts channels: ' + contractsChannels.length + '\n');

  const errors = [];

  // Contracts vs generated (must match exactly)
  errors.push(
    ...compareAgainstSource({
      sourceName: 'contracts',
      sourceChannels: contractsChannels,
      targetName: 'generated',
      targetChannels: generatedChannels,
    }),
    ...compareAgainstSource({
      sourceName: 'generated',
      sourceChannels: generatedChannels,
      targetName: 'contracts',
      targetChannels: contractsChannels,
    })
  );

  if (legacyShim.channels) {
    console.log('Legacy shim mode: direct re-export from contracts channels.');

    if (!legacyShim.types) {
      errors.push(
        'Legacy IPC shim must also re-export types from @contracts/types when channel re-export mode is enabled'
      );
    }
  } else {
    errors.push(
      ...compareAgainstSource({
        sourceName: 'legacy shim',
        sourceChannels: legacyChannels,
        targetName: 'contracts',
        targetChannels: contractsChannels,
      }),
      ...compareAgainstSource({
        sourceName: 'contracts',
        sourceChannels: contractsChannels,
        targetName: 'legacy shim',
        targetChannels: legacyChannels,
      })
    );
  }

  // Report results
  if (errors.length > 0) {
    console.log('ERRORS:\n');
    errors.forEach(e => console.log(e + '\n'));
    console.log('\nRun `npm run generate:ipc` to regenerate.\n');
    process.exit(1);
  }

  console.log('IPC channels are synchronized.\n');
  console.log('Summary:');
  console.log('  - ' + contractsChannels.length + ' channels in contracts');
  console.log('  - ' + generatedChannels.length + ' channels in generated file');
  console.log('  - ' + legacyChannels.length + ' channels in legacy shim');
  process.exit(0);
}

main();
