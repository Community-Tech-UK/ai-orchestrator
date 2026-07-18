import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AndroidExecFile } from './android-detect';
import { detectAndroidAutomation, parseAdbDevicesOutput } from './android-detect';

function execStub(outputs: Record<string, string>): AndroidExecFile {
  return vi.fn((command, args, options, callback) => {
    void options;
    const key = [command, ...args].join(' ');
    const stdout = outputs[key] ?? '';
    queueMicrotask(() => callback(null, stdout, ''));
    return { kill: vi.fn() } as never;
  }) as unknown as AndroidExecFile;
}

describe('parseAdbDevicesOutput', () => {
  it('parses emulator, usb, wifi, offline, and unauthorized devices', () => {
    const devices = parseAdbDevicesOutput(`
List of devices attached
emulator-5554 device product:sdk_gphone64 model:Pixel_7 device:emu transport_id:1
R58M1234 unauthorized usb:1-1 product:oriole model:Pixel_6 device:oriole transport_id:2
192.168.1.20:5555 offline product:panther model:Pixel_7 device:panther transport_id:3
`);

    expect(devices).toEqual([
      { serial: 'emulator-5554', kind: 'emulator', state: 'device', model: 'Pixel 7' },
      { serial: 'R58M1234', kind: 'usb', state: 'unauthorized', model: 'Pixel 6' },
      { serial: '192.168.1.20:5555', kind: 'wifi', state: 'offline', model: 'Pixel 7' },
    ]);
  });
});

describe('detectAndroidAutomation', () => {
  it('resolves SDK tools, AVDs, devices, API levels, and Maestro defensively', async () => {
    const sdkPath = '/android/sdk';
    const execFile = execStub({
      [`${sdkPath}/platform-tools/adb --version`]: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0\n',
      [`${sdkPath}/platform-tools/adb devices -l`]: `
List of devices attached
emulator-5554 device product:sdk model:Pixel_7 device:emu
USB123 device usb:1-1 model:Pixel_8
`,
      [`${sdkPath}/platform-tools/adb -s emulator-5554 shell getprop ro.build.version.sdk`]: '35\n',
      [`${sdkPath}/platform-tools/adb -s USB123 shell getprop ro.build.version.sdk`]: '34\n',
      [`${sdkPath}/emulator/emulator -list-avds`]: 'aio-pixel7-api35\nOther_AVD\n',
      'maestro --version': '2.0.0\n',
    });

    const summary = await detectAndroidAutomation({
      config: { enabled: true, sdkPath },
      execFile,
      exists: (candidate) => candidate.startsWith(sdkPath),
      platform: 'linux',
      homedir: () => '/home/james',
    });

    expect(summary).toEqual({
      enabled: true,
      sdkPath,
      adbVersion: 'Android Debug Bridge version 1.0.41',
      avds: ['aio-pixel7-api35', 'Other_AVD'],
      connectedDevices: [
        { serial: 'emulator-5554', kind: 'emulator', state: 'device', model: 'Pixel 7', apiLevel: 35 },
        { serial: 'USB123', kind: 'usb', state: 'device', model: 'Pixel 8', apiLevel: 34 },
      ],
      emulatorRunning: true,
      hasMaestro: true,
    });
  });

  it('resolves the win32 default SDK root under %LOCALAPPDATA% and .exe-suffixed tools', async () => {
    // Mirror windows-pc: C:\Users\shutu\AppData\Local\Android\Sdk.
    const localAppData = 'C:\\Users\\shutu\\AppData\\Local';
    const sdkPath = path.win32.join(localAppData, 'Android', 'Sdk');
    const adbExe = path.win32.join(sdkPath, 'platform-tools', 'adb.exe');
    const emulatorExe = path.win32.join(sdkPath, 'emulator', 'emulator.exe');

    const execFile = execStub({
      [`${adbExe} --version`]: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0\n',
      [`${adbExe} devices -l`]: 'List of devices attached\nemulator-5554 device model:Pixel_7\n',
      [`${adbExe} -s emulator-5554 shell getprop ro.build.version.sdk`]: '35\n',
      [`${emulatorExe} -list-avds`]: 'sbe_test\n',
    });

    const summary = await detectAndroidAutomation({
      config: { enabled: true },
      env: { LOCALAPPDATA: localAppData },
      // Only the win32 SDK root and its .exe tools "exist".
      exists: (candidate) =>
        candidate === sdkPath || candidate === adbExe || candidate === emulatorExe,
      execFile,
      platform: 'win32',
      homedir: () => 'C:\\Users\\shutu',
    });

    expect(summary).toEqual({
      enabled: true,
      sdkPath,
      adbVersion: 'Android Debug Bridge version 1.0.41',
      avds: ['sbe_test'],
      connectedDevices: [
        { serial: 'emulator-5554', kind: 'emulator', state: 'device', model: 'Pixel 7', apiLevel: 35 },
      ],
      emulatorRunning: true,
      hasMaestro: false,
    });
  });

  it('returns undefined rather than throwing when no SDK root is resolvable', async () => {
    await expect(
      detectAndroidAutomation({
        env: {},
        exists: () => false,
        execFile: execStub({}),
        platform: 'linux',
        homedir: () => '/home/james',
      }),
    ).resolves.toBeUndefined();
  });

  it('falls back to adb and emulator on PATH when no SDK root is resolvable', async () => {
    const execFile = execStub({
      'adb --version': 'Android Debug Bridge version 1.0.41\nVersion 36.0.0\n',
      'adb devices -l': 'List of devices attached\nUSB123 device usb:1-1 model:Pixel_8\n',
      'adb -s USB123 shell getprop ro.build.version.sdk': '34\n',
      'emulator -list-avds': 'aio-pixel7-api35\n',
    });

    const summary = await detectAndroidAutomation({
      config: { enabled: true },
      env: {},
      exists: () => false,
      execFile,
      platform: 'linux',
      homedir: () => '/home/james',
    });

    expect(summary).toEqual({
      enabled: true,
      sdkPath: '',
      adbVersion: 'Android Debug Bridge version 1.0.41',
      avds: ['aio-pixel7-api35'],
      connectedDevices: [
        { serial: 'USB123', kind: 'usb', state: 'device', model: 'Pixel 8', apiLevel: 34 },
      ],
      emulatorRunning: false,
      hasMaestro: false,
    });
  });
});
