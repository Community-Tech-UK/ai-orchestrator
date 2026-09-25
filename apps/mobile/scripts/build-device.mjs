#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const mobileRoot = resolve(dirname(scriptPath), '..');
const bundleIdentifier = 'com.shutupandshave.aiorchestrator';

export function parseDeviceBuildOptions(argv, env = process.env) {
  const options = {
    deviceId: env.HARNESS_IOS_DEVICE_ID?.trim() ?? '',
    teamId: env.HARNESS_IOS_TEAM_ID?.trim() ?? '',
    derivedDataPath: resolve(mobileRoot, 'ios/build-device'),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    const value = argv[index + 1];
    if (argument === '--device' || argument === '--team' || argument === '--derived-data') {
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === '--device') options.deviceId = value;
      if (argument === '--team') options.teamId = value;
      if (argument === '--derived-data') options.derivedDataPath = resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.help) {
    if (!options.deviceId) {
      throw new Error('Set --device or HARNESS_IOS_DEVICE_ID to the connected CoreDevice identifier or name.');
    }
    if (!options.teamId) {
      throw new Error('Set --team or HARNESS_IOS_TEAM_ID to the Apple Developer team identifier.');
    }
  }

  return options;
}

export function xcodebuildArguments(options) {
  return [
    '-workspace',
    'ios/App/App.xcworkspace',
    '-scheme',
    'App',
    '-configuration',
    'Debug',
    '-sdk',
    'iphoneos',
    '-destination',
    xcodeDestination(options.deviceId),
    '-derivedDataPath',
    options.derivedDataPath,
    `DEVELOPMENT_TEAM=${options.teamId}`,
    'CODE_SIGN_STYLE=Automatic',
    '-allowProvisioningUpdates',
    'build',
  ];
}

export function xcodeDestination(deviceIdOrName) {
  const physicalUdid = /^[0-9a-f]{8}-[0-9a-f]{16}$/i;
  const simulatorUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  return physicalUdid.test(deviceIdOrName) || simulatorUuid.test(deviceIdOrName)
    ? `id=${deviceIdOrName}`
    : `platform=iOS,name=${deviceIdOrName}`;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: mobileRoot,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

export function runDeviceBuild(options, runCommand = run) {
  console.log('Building web assets and syncing the tracked iOS project…');
  runCommand('npm', ['run', 'sync']);

  console.log(`Building a signed development app for ${options.deviceId}…`);
  runCommand('xcodebuild', xcodebuildArguments(options));

  const appPath = resolve(options.derivedDataPath, 'Build/Products/Debug-iphoneos/App.app');
  if (!existsSync(appPath)) {
    throw new Error(`The signed app bundle was not created at ${appPath}`);
  }

  console.log('Installing the app with CoreDevice…');
  runCommand('xcrun', [
    'devicectl',
    'device',
    'install',
    'app',
    '--device',
    options.deviceId,
    '--timeout',
    '120',
    appPath,
  ]);

  console.log('Launching harness…');
  runCommand('xcrun', [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    options.deviceId,
    '--timeout',
    '60',
    '--terminate-existing',
    bundleIdentifier,
  ]);
}

function printUsage() {
  console.log(`Usage: npm run ios:device -- --device <CoreDevice ID or name> --team <Apple team ID>

Environment alternatives:
  HARNESS_IOS_DEVICE_ID   CoreDevice identifier or device name
  HARNESS_IOS_TEAM_ID     Apple Developer team identifier

Optional:
  --derived-data <path>   Build output (default: apps/mobile/ios/build-device)`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseDeviceBuildOptions(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      runDeviceBuild(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
