import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG_PATH,
  getConfiguredCoordinatorUrl,
  loadWorkerConfig,
  persistConfig,
} from '../worker-config';
import {
  generateLaunchAgentPlist,
  launchAgentPlistPath,
  WORKER_LAUNCH_AGENT_LABEL,
} from '../service/macos-launch-agent';
import { resolveWorkerChildCommand } from '../worker-supervisor';
import { checkHostReadiness, openTailscaleApp } from '../host-readiness';
import type { HostReadinessCheck, WorkerNodeHostReadiness } from '../../shared/types/worker-node.types';
import { setUpBrowserFeatures } from './browser-setup';

export interface InstallAgentOptions {
  configPath?: string;
  name?: string;
  browser: boolean;
}

export interface InstallAgentDeps {
  stdout?: (text: string) => void;
  platform?: NodeJS.Platform;
  uid?: number;
  homedir?: string;
  launchctl?: (args: string[]) => Promise<{ code: number; output: string }>;
  setUpBrowser?: (configPath: string) => string[];
  checkHost?: () => Promise<WorkerNodeHostReadiness | undefined>;
  openTailscale?: () => Promise<{ ok: boolean; message: string }>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `aio-worker install-agent`: run the worker in this Mac user's logged-in
 * session, started at login and restarted if it stops. No administrator
 * password. Also names the computer, turns browser features on when Chrome is
 * installed, and reports the Mac settings an unattended worker needs.
 */
export async function runInstallAgent(options: InstallAgentOptions, deps: InstallAgentDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const say = (line: string): void => stdout(`${line}\n`);
  if ((deps.platform ?? process.platform) !== 'darwin') {
    say('install-agent is for macOS. On Windows, use scripts/windows/install-worker-launcher.ps1.');
    return 1;
  }
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  if (uid === 0) {
    say('Run install-agent as the Mac user who will be logged in, not with sudo.');
    return 1;
  }
  const homedir = deps.homedir ?? os.homedir();
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  const config = loadWorkerConfig(configPath);
  if (options.name) {
    config.name = options.name;
    persistConfig(configPath, config);
  }
  say(`This computer is named ${config.name}.${options.name ? '' : ' Use --name to change it.'}`);
  if (options.browser) {
    (deps.setUpBrowser ?? setUpBrowserFeatures)(configPath).forEach(say);
  }

  const childArgs = ['--supervise', ...(configPath === DEFAULT_CONFIG_PATH ? [] : ['--config', configPath])];
  const { exe, args } = resolveWorkerChildCommand(childArgs);
  const entrypoint = args[0] && args[0] !== '--supervise' ? args[0] : undefined;
  const logDir = path.join(path.dirname(configPath), 'logs');
  const plistPath = launchAgentPlistPath(homedir);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(plistPath, generateLaunchAgentPlist({
    programArguments: [exe, ...args],
    // A source checkout's worker lives at <checkout>/dist/worker-agent/index.js.
    workingDirectory: entrypoint ? path.resolve(path.dirname(entrypoint), '..', '..') : homedir,
    path: process.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    logDir,
  }));

  const launchctl = deps.launchctl ?? runLaunchctl;
  const domain = `gui/${uid}`;
  // Replace a running copy (including a hand-made agent with the same label).
  // Boot-out finishes in the background, so a bootstrap straight after it can
  // fail with an I/O error; try a few times before giving up.
  await launchctl(['bootout', `${domain}/${WORKER_LAUNCH_AGENT_LABEL}`]);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let loaded = await launchctl(['bootstrap', domain, plistPath]);
  for (let attempt = 1; loaded.code !== 0 && attempt < 4; attempt++) {
    await sleep(1_000);
    loaded = await launchctl(['bootstrap', domain, plistPath]);
  }
  if (loaded.code !== 0) {
    say(`Wrote ${plistPath} but macOS would not start it: ${loaded.output.trim() || `launchctl exit ${loaded.code}`}`);
    const session = await launchctl(['print', domain]);
    if (session.code !== 0) {
      say('Nobody is logged in on this Mac\'s screen. Log in there, then run install-agent again.');
    }
    return 1;
  }
  say(`Worker installed for this user (${plistPath}). It starts at login and restarts if it stops.`);
  say(getConfiguredCoordinatorUrl(config)
    ? 'If macOS asks whether the worker may find devices on your local network, click Allow.'
    : 'It is waiting to be paired: run aio-worker pair "<link>" here, or ask an agent in Harness for a pairing command.');

  await reportHostReadiness(say, deps);
  return 0;
}

/** `aio-worker uninstall-agent`: stop the per-user worker and remove its LaunchAgent. */
export async function runUninstallAgent(deps: InstallAgentDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const plistPath = launchAgentPlistPath(deps.homedir ?? os.homedir());
  await (deps.launchctl ?? runLaunchctl)(['bootout', `gui/${uid}/${WORKER_LAUNCH_AGENT_LABEL}`]);
  fs.rmSync(plistPath, { force: true });
  stdout(`Worker stopped and ${plistPath} removed.\n`);
  return 0;
}

/** `aio-worker check-host`, and the end of install-agent. */
export async function reportHostReadiness(say: (line: string) => void, deps: InstallAgentDeps = {}): Promise<void> {
  const readiness = await (deps.checkHost ?? (() => checkHostReadiness({ localNetwork: 'unknown' }, {}, { force: true })))();
  if (!readiness) {
    say('Host checks run on macOS only.');
    return;
  }
  let checks = readiness.checks;
  const tailscale = checks.find((check) => check.id === 'tailscale_running');
  if (tailscale?.status === 'problem' && !tailscale.needsAdmin) {
    const opened = await (deps.openTailscale ?? (() => openTailscaleApp()))();
    say(opened.message);
    if (opened.ok) {
      checks = checks.filter((check) => check !== tailscale);
    }
  }
  const attention = checks.filter((check) => check.status === 'problem' || check.status === 'note');
  if (attention.length === 0) {
    say('This Mac is set up for unattended work.');
    return;
  }
  say('This Mac\'s settings for unattended work:');
  attention.forEach((check) => say(describeCheck(check)));
}

function describeCheck(check: HostReadinessCheck): string {
  const fix = check.fix ? ` Fix: ${check.fix}${check.needsAdmin ? ' (needs an admin password)' : ''}` : '';
  return `- ${check.summary}${fix}`;
}

function runLaunchctl(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile('/bin/launchctl', args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

/** Parse `install-agent [--name <n>] [--no-browser] [--config <path>]`. */
export function parseInstallAgentArgs(argv: string[]): InstallAgentOptions {
  const options: InstallAgentOptions = { browser: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--name') options.name = value();
    else if (arg === '--config') options.configPath = value();
    else if (arg === '--no-browser') options.browser = false;
    else throw new Error(`Unknown install-agent option: ${arg}`);
  }
  return options;
}
