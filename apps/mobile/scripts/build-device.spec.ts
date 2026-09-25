import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeviceBuildOptions, xcodebuildArguments, xcodeDestination } from './build-device.mjs';

describe('build-device CLI', () => {
  it('requires both an explicit device and signing team', () => {
    expect(() => parseDeviceBuildOptions([], {})).toThrow(/HARNESS_IOS_DEVICE_ID/);
    expect(() => parseDeviceBuildOptions(['--device', 'Test iPhone'], {})).toThrow(
      /HARNESS_IOS_TEAM_ID/,
    );
  });

  it('accepts environment defaults and lets CLI flags override them', () => {
    const options = parseDeviceBuildOptions(
      ['--device', 'Selected iPhone', '--derived-data', './_scratch/device-build'],
      {
        HARNESS_IOS_DEVICE_ID: 'Environment iPhone',
        HARNESS_IOS_TEAM_ID: 'TESTTEAM01',
      },
    );

    expect(options).toEqual({
      deviceId: 'Selected iPhone',
      teamId: 'TESTTEAM01',
      derivedDataPath: resolve('./_scratch/device-build'),
      help: false,
    });
  });

  it('builds for the selected physical device with signing supplied at runtime', () => {
    const args = xcodebuildArguments({
      deviceId: 'Selected iPhone',
      teamId: 'TESTTEAM01',
      derivedDataPath: '/tmp/harness-device-build',
      help: false,
    });

    expect(args).toContain('iphoneos');
    expect(args).toContain('platform=iOS,name=Selected iPhone');
    expect(args).toContain('DEVELOPMENT_TEAM=TESTTEAM01');
    expect(args).toContain('CODE_SIGN_STYLE=Automatic');
    expect(args).toContain('-allowProvisioningUpdates');
  });

  it('uses Xcode id destinations for physical UDIDs and simulator UUIDs', () => {
    expect(xcodeDestination('00000000-0000000000000000')).toBe(
      'id=00000000-0000000000000000',
    );
    expect(xcodeDestination('00000000-0000-0000-0000-000000000000')).toBe(
      'id=00000000-0000-0000-0000-000000000000',
    );
  });
});
