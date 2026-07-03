import { execFile, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AndroidDeviceInfo,
  NodePlatform,
  WorkerNodeAndroidAutomationSummary,
} from '../../shared/types/worker-node.types';
import type { WorkerAndroidAutomationConfig } from '../worker-config';

export type AndroidExecFile = (
  command: string,
  args: string[],
  options: { timeout: number; windowsHide?: boolean },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => ChildProcess;

interface DetectAndroidOptions {
  config?: WorkerAndroidAutomationConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodePlatform;
  homedir?: () => string;
  exists?: (candidatePath: string) => boolean;
  execFile?: AndroidExecFile;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export async function detectAndroidAutomation(
  options: DetectAndroidOptions = {},
): Promise<WorkerNodeAndroidAutomationSummary | undefined> {
  const platform = options.platform ?? (process.platform as NodePlatform);
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir;
  const exists = options.exists ?? pathExists;
  const exec = options.execFile ?? execFile;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sdkPath = resolveAndroidSdkRoot({
    override: options.config?.sdkPath,
    env,
    platform,
    homedir,
    exists,
  });

  const adbPath = sdkPath
    ? resolveAndroidTool(sdkPath, ['platform-tools', executableName('adb', platform)], exists, platform) ?? 'adb'
    : 'adb';
  const emulatorPath = sdkPath
    ? resolveAndroidTool(sdkPath, ['emulator', executableName('emulator', platform)], exists, platform) ?? 'emulator'
    : 'emulator';

  const [adbVersionRaw, devicesRaw, avdsRaw, maestroRaw] = await Promise.all([
    runCommand(exec, adbPath, ['--version'], timeoutMs),
    runCommand(exec, adbPath, ['devices', '-l'], timeoutMs),
    runCommand(exec, emulatorPath, ['-list-avds'], timeoutMs),
    runCommand(exec, 'maestro', ['--version'], timeoutMs),
  ]);

  const connectedDevices = parseAdbDevicesOutput(devicesRaw);
  const adbVersion = parseAdbVersion(adbVersionRaw);
  if (!sdkPath && !adbVersion) {
    return undefined;
  }
  const devicesWithApi = await Promise.all(
    connectedDevices.map(async (device) => {
      if (device.state !== 'device') {
        return device;
      }
      const apiRaw = await runCommand(
        exec,
        adbPath,
        ['-s', device.serial, 'shell', 'getprop', 'ro.build.version.sdk'],
        timeoutMs,
      );
      const apiLevel = Number.parseInt(apiRaw.trim(), 10);
      return Number.isInteger(apiLevel) && apiLevel > 0
        ? { ...device, apiLevel }
        : device;
      }),
  );

  return {
    enabled: options.config?.enabled === true,
    sdkPath: sdkPath ?? '',
    ...(adbVersion ? { adbVersion } : {}),
    avds: parseAvdList(avdsRaw),
    connectedDevices: devicesWithApi,
    emulatorRunning: devicesWithApi.some((device) =>
      device.kind === 'emulator' && device.state === 'device'
    ),
    hasMaestro: maestroRaw.trim().length > 0,
  };
}

export function parseAdbDevicesOutput(output: string): AndroidDeviceInfo[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.toLowerCase().startsWith('list of devices'))
    .map((line): AndroidDeviceInfo | null => {
      const [serial, state, ...parts] = line.split(/\s+/);
      if (!serial || !isAndroidDeviceState(state)) {
        return null;
      }
      return {
        serial,
        kind: inferDeviceKind(serial, parts),
        state,
        ...parseDeviceMetadata(parts),
      };
    })
    .filter((device): device is AndroidDeviceInfo => device !== null);
}

function resolveAndroidSdkRoot(input: {
  override?: string;
  env: NodeJS.ProcessEnv;
  platform: NodePlatform;
  homedir: () => string;
  exists: (candidatePath: string) => boolean;
}): string | undefined {
  const candidates = [
    input.override,
    input.env['ANDROID_HOME'],
    input.env['ANDROID_SDK_ROOT'],
    ...defaultSdkRoots(input.platform, input.env, input.homedir),
  ];
  return candidates.find((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.trim().length > 0 && input.exists(candidate)
  );
}

function defaultSdkRoots(
  platform: NodePlatform,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string[] {
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    return localAppData ? [path.win32.join(localAppData, 'Android', 'Sdk')] : [];
  }
  if (platform === 'darwin') {
    return [path.posix.join(homedir(), 'Library', 'Android', 'sdk')];
  }
  return [path.posix.join(homedir(), 'Android', 'Sdk')];
}

function resolveAndroidTool(
  sdkPath: string,
  segments: string[],
  exists: (candidatePath: string) => boolean,
  platform: NodePlatform,
): string | undefined {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const candidate = pathApi.join(sdkPath, ...segments);
  return exists(candidate) ? candidate : undefined;
}

function executableName(name: string, platform: NodePlatform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

async function runCommand(
  exec: AndroidExecFile,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  try {
    return await new Promise<string>((resolve) => {
      exec(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        resolve(bufferToString(stdout));
      });
    });
  } catch {
    return '';
  }
}

function bufferToString(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf-8');
}

function parseAdbVersion(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function parseAvdList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isAndroidDeviceState(state: string | undefined): state is AndroidDeviceInfo['state'] {
  return state === 'device' || state === 'offline' || state === 'unauthorized';
}

function inferDeviceKind(serial: string, parts: string[]): AndroidDeviceInfo['kind'] {
  if (serial.startsWith('emulator-')) {
    return 'emulator';
  }
  if (serial.includes(':')) {
    return 'wifi';
  }
  return parts.some((part) => part.startsWith('usb:')) ? 'usb' : 'usb';
}

function parseDeviceMetadata(parts: string[]): Partial<AndroidDeviceInfo> {
  const modelPart = parts.find((part) => part.startsWith('model:'));
  const model = modelPart
    ? modelPart.slice('model:'.length).replace(/_/g, ' ')
    : undefined;
  return model ? { model } : {};
}

function pathExists(candidatePath: string): boolean {
  try {
    // Lazily require fs so tests can supply `exists` without touching disk.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    fs.accessSync(candidatePath);
    return true;
  } catch {
    return false;
  }
}
