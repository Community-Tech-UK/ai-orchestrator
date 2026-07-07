#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IOS_INFO_PLIST = 'ios/App/App/Info.plist';

const PLIST_STRING_VALUES = new Map([
  ['CFBundleDisplayName', 'harness'],
  ['CFBundleName', 'harness'],
  ['NSFaceIDUsageDescription', 'harness uses Face ID to unlock the app and protect your agent sessions.'],
  ['NSCameraUsageDescription', 'harness uses the camera to scan the pairing QR code shown on your Mac.'],
  ['NSPhotoLibraryUsageDescription', 'harness lets you attach photos from your library to send to an agent.'],
  [
    'NSLocalNetworkUsageDescription',
    'harness connects to your Mac over your private Tailscale network to control your agent sessions.',
  ],
  ['NSMicrophoneUsageDescription', 'harness uses the microphone so you can dictate messages to an agent.'],
  [
    'NSSpeechRecognitionUsageDescription',
    'harness transcribes your dictation on-device so you can speak instead of type.',
  ],
]);

/** Boolean plist flags (e.g. Live Activities support). */
const PLIST_BOOL_VALUES = new Map([['NSSupportsLiveActivities', true]]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapePlistString(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function setPlistStringValue(plist, key, value) {
  const escapedKey = escapeRegExp(key);
  const pattern = new RegExp(`(<key>${escapedKey}</key>\\s*<string>)[\\s\\S]*?(</string>)`);
  const escapedValue = escapePlistString(value);

  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${escapedValue}$2`);
  }

  if (!plist.includes('</dict>')) {
    throw new Error(`Cannot add ${key}: Info.plist is missing </dict>`);
  }

  return plist.replace(
    /\n<\/dict>/,
    `\n\t<key>${key}</key>\n\t<string>${escapedValue}</string>\n</dict>`,
  );
}

export function setPlistBoolValue(plist, key, value) {
  const escapedKey = escapeRegExp(key);
  const tag = value ? '<true/>' : '<false/>';
  const pattern = new RegExp(`(<key>${escapedKey}</key>\\s*)(<true/>|<false/>)`);

  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${tag}`);
  }

  if (!plist.includes('</dict>')) {
    throw new Error(`Cannot add ${key}: Info.plist is missing </dict>`);
  }

  return plist.replace(/\n<\/dict>/, `\n\t<key>${key}</key>\n\t${tag}\n</dict>`);
}

export function withHarnessIosDisplayName(plist) {
  let updated = plist;
  for (const [key, value] of PLIST_STRING_VALUES) {
    updated = setPlistStringValue(updated, key, value);
  }
  for (const [key, value] of PLIST_BOOL_VALUES) {
    updated = setPlistBoolValue(updated, key, value);
  }
  return updated;
}

export async function ensureIosDisplayName(projectRoot = PROJECT_ROOT) {
  const plistPath = resolve(projectRoot, IOS_INFO_PLIST);
  const original = await readFile(plistPath, 'utf8');
  const updated = withHarnessIosDisplayName(original);

  if (updated !== original) {
    await writeFile(plistPath, updated);
    console.log(`Updated ${IOS_INFO_PLIST} display metadata to harness`);
  } else {
    console.log(`${IOS_INFO_PLIST} display metadata already uses harness`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;

if (invokedPath === import.meta.url) {
  ensureIosDisplayName().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
