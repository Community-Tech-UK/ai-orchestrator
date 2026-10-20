import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { resolveWorkerModeRuntimeCommand } from './worker-mode-runtime-service';

const logger = getLogger('WorkerSignInTask');

export const SIGN_IN_TASK_PATH = '\\Harness\\';
export const SIGN_IN_TASK_NAME = 'Harness Worker';
const KEEP_ALIVE_MINUTES = 5;
const POWERSHELL_TIMEOUT_MS = 60_000;

/**
 * Runs the Worker Mode worker on Windows independently of Harness, the way
 * windows-pc does (scripts/windows/install-worker-launcher.ps1): a per-user
 * scheduled task starts a hidden, blocking launcher at sign-in and a separate
 * 5-minute keep-alive trigger brings a dead worker back. Everything runs as the
 * signed-in user with no elevation, so the worker sees that user's CLI logins
 * and desktop — which an OS service account cannot.
 *
 * The worker runs from a private copy under %LOCALAPPDATA%\Harness\worker so
 * a running worker never locks files the Harness installer has to replace.
 * Each Harness build gets its own version folder; `ensureCurrent()` moves the
 * task onto a new build at launch.
 */

export interface SignInTaskState {
  /** False when the user paused the worker ("Stop Worker"). */
  enabled: boolean;
  present: boolean;
}

interface DeploymentRecord {
  buildId: string;
  exePath: string;
}

export interface WorkerSignInTaskOptions {
  platform?: NodeJS.Platform;
  /** Defaults to %LOCALAPPDATA%. */
  localAppData?: string;
  /** Runs a PowerShell script; resolves stdout, rejects on failure. */
  runPowerShell?: (script: string) => Promise<string>;
  /** Path of the worker executable bundled with Harness. */
  resolveBundledWorker?: () => string;
}

export class WorkerSignInTask {
  private readonly platform: NodeJS.Platform;
  private readonly localAppData: string | undefined;
  private readonly runPowerShell: (script: string) => Promise<string>;
  private readonly resolveBundledWorker: () => string;
  /**
   * Serialises every task action. Launch-time `ensureCurrent()` re-registers
   * (which re-enables) the task, so a Stop pressed meanwhile would otherwise be
   * silently undone; rapid role toggles likewise fired start and stop at once.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkerSignInTaskOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.localAppData = options.localAppData ?? process.env['LOCALAPPDATA'];
    this.runPowerShell = options.runPowerShell ?? runPowerShellScript;
    this.resolveBundledWorker = options.resolveBundledWorker
      ?? (() => resolveWorkerModeRuntimeCommand().command);
  }

  isSupported(): boolean {
    return this.platform === 'win32';
  }

  paths(): {
    root: string;
    versionsDir: string;
    launcherPath: string;
    deploymentPath: string;
    switchingMarkerPath: string;
  } {
    if (!this.localAppData) {
      throw new Error('Cannot find your local app data folder (LOCALAPPDATA is not set).');
    }
    const root = path.join(this.localAppData, 'Harness', 'worker');
    return {
      root,
      versionsDir: path.join(root, 'versions'),
      launcherPath: path.join(root, 'run-worker-hidden.vbs'),
      deploymentPath: path.join(root, 'deployment.json'),
      switchingMarkerPath: path.join(root, 'switching'),
    };
  }

  /**
   * Deploy the bundled worker, (re)register the task and start it. Stops a
   * worker already running from an older copy first so only one runs.
   */
  async install(configPath: string): Promise<void> {
    this.assertSupported();
    await this.serialised(async () => {
      const deployment = await this.redeploy(configPath, await this.readTaskState());
      await this.ps(`${taskRef()}
Enable-ScheduledTask @task | Out-Null
Start-ScheduledTask @task`);
      await this.pruneVersions(deployment.buildId);
      logger.info('Sign-in worker installed and started', { buildId: deployment.buildId });
    });
  }

  /**
   * Launch-time upkeep: move the task onto the build bundled with this
   * Harness, or restore a task that was deleted. A paused (disabled) task stays
   * paused. Returns true when anything changed.
   */
  async ensureCurrent(configPath: string): Promise<boolean> {
    this.assertSupported();
    return this.serialised(async () => {
      const state = await this.readTaskState();
      // A disabled task with the switching marker was paused by an
      // interrupted switch-over (Harness quit mid-update), not by the user.
      const interrupted = state.present && !state.enabled && await exists(this.paths().switchingMarkerPath);
      if (interrupted) {
        state.enabled = true;
      }
      const deployed = await this.readDeployment();
      const buildId = await this.bundledBuildId();
      if (
        !interrupted
        && state.present
        && deployed?.buildId === buildId
        && await exists(deployed.exePath)
        && await exists(this.paths().launcherPath)
      ) {
        return false;
      }
      const deployment = await this.redeploy(configPath, state);
      // Registering re-enables the task; a worker the user paused stays paused.
      await this.ps(state.present && !state.enabled
        ? `${taskRef()}
Disable-ScheduledTask @task | Out-Null`
        : `${taskRef()}
Start-ScheduledTask @task`);
      await this.pruneVersions(deployment.buildId);
      logger.info('Sign-in worker moved to the bundled build', {
        from: deployed?.buildId ?? null,
        to: deployment.buildId,
        paused: state.present && !state.enabled,
      });
      return true;
    });
  }

  /** Resume a paused worker. */
  async start(): Promise<void> {
    this.assertSupported();
    await this.serialised(async () => {
      await this.ps(`${taskRef()}
Enable-ScheduledTask @task | Out-Null
Start-ScheduledTask @task`);
      await this.clearSwitchingMarker();
    });
  }

  /**
   * Pause the worker: disable the task (so the keep-alive does not bring it
   * straight back) and end the running worker. Resolves once it has exited.
   * A task that is missing or not running is not an error.
   */
  async stop(): Promise<void> {
    if (!this.isSupported()) {
      return;
    }
    await this.serialised(async () => {
      // The user's pause wins over a switch-over a crash left half done. Strict:
      // a marker left behind would make the next launch undo this Stop, so a
      // failure must fail the Stop visibly rather than pause and lie.
      await this.clearSwitchingMarker({ strict: true });
      await this.ps(`${taskRef()}
${PAUSE_TASK}`);
      await this.stopWorkerProcesses();
    });
  }

  /** Remove the task and end the worker. The version folders are pruned. */
  async remove(): Promise<void> {
    if (!this.isSupported()) {
      return;
    }
    await this.serialised(async () => {
      await this.ps(`${taskRef()}
try { Stop-ScheduledTask @task } catch { }
try { Unregister-ScheduledTask @task -Confirm:$false } catch { ${RETHROW_UNLESS_NOT_FOUND} }`);
      await this.stopWorkerProcesses();
      await this.pruneVersions(null);
      await this.clearSwitchingMarker();
      logger.info('Sign-in worker removed');
    });
  }

  async getTaskState(): Promise<SignInTaskState> {
    this.assertSupported();
    return this.serialised(() => this.readTaskState());
  }

  private async readTaskState(): Promise<SignInTaskState> {
    // Only "no such task" means absent; a Task Scheduler fault must not be
    // mistaken for it (that would re-register and un-pause a paused worker).
    const output = await this.ps(`${taskRef()}
try { $found = Get-ScheduledTask @task } catch { ${RETHROW_UNLESS_NOT_FOUND}; $found = $null }
if ($null -eq $found) { 'absent' } elseif ($found.State -eq 'Disabled') { 'disabled' } else { 'enabled' }`);
    const value = output.trim().split(/\r?\n/).pop()?.trim();
    return { present: value === 'enabled' || value === 'disabled', enabled: value === 'enabled' };
  }

  /**
   * Move the task onto the bundled build.
   *
   * The new copy is prepared while the old worker still runs: a copy that
   * fails (antivirus holding the folder, disk full) then leaves the old worker
   * untouched, and the switch-over is short. The task is disabled before the
   * worker is killed so its keep-alive cannot start the OLD build before
   * re-registering (which re-enables it). If the switch-over fails, a task
   * that was running is re-enabled — otherwise it would stay disabled and the
   * next launch would mistake that for the user's pause. The deployment record
   * is written last, so a failed attempt is retried at the next launch.
   */
  private async redeploy(configPath: string, previous: SignInTaskState): Promise<DeploymentRecord> {
    const deployment = await this.prepareCopy();
    const { switchingMarkerPath } = this.paths();
    // Marks "disabled by Harness, not by the user" until the switch-over ends,
    // so a Harness that quits in the middle does not leave a fake pause.
    if (previous.present && previous.enabled) {
      await fsp.writeFile(switchingMarkerPath, `${new Date().toISOString()}\n`, 'utf8');
    }
    try {
      await this.ps(`${taskRef()}
${PAUSE_TASK}`);
      await this.stopWorkerProcesses();
      await this.writeLauncher(deployment.exePath, configPath);
      await this.registerTask();
      await this.writeDeploymentRecord(deployment);
    } catch (error) {
      if (previous.present && previous.enabled) {
        await this.ps(`${taskRef()}
try { Enable-ScheduledTask @task | Out-Null; Start-ScheduledTask @task } catch { }`).catch(() => undefined);
      }
      throw error;
    } finally {
      await this.clearSwitchingMarker();
    }
    return deployment;
  }

  /**
   * Best effort by default: once the task is enabled (start, a finished
   * switch-over) or gone (remove), a leftover marker is inert. stop() is
   * strict — see there.
   */
  private async clearSwitchingMarker(options: { strict?: boolean } = {}): Promise<void> {
    try {
      await fsp.rm(this.paths().switchingMarkerPath, { force: true });
    } catch (error) {
      if (options.strict) {
        throw error;
      }
      logger.warn('Could not remove the sign-in worker switching marker', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private serialised<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Every script ends `exit 0`. powershell.exe sets its exit code from `$?` of
   * the LAST statement, and `-ErrorAction SilentlyContinue` hides an error
   * without clearing `$?` — so "remove a task that is already gone" exited 1.
   * Real failures still exit 1 earlier via `$ErrorActionPreference = 'Stop'`.
   */
  private ps(script: string): Promise<string> {
    return this.runPowerShell(`$ProgressPreference = 'SilentlyContinue'
${script}
exit 0`);
  }

  private assertSupported(): void {
    if (!this.isSupported()) {
      throw new Error('Keeping the worker running with Harness closed is only available on Windows.');
    }
  }

  private async bundledBuildId(): Promise<string> {
    const exe = this.resolveBundledWorker();
    const stat = await fsp.stat(exe);
    return createHash('sha256')
      .update(`${path.basename(exe)}|${stat.size}|${Math.trunc(stat.mtimeMs)}`)
      .digest('hex')
      .slice(0, 12);
  }

  private async prepareCopy(): Promise<DeploymentRecord> {
    const { versionsDir } = this.paths();
    const bundledExe = this.resolveBundledWorker();
    const buildId = await this.bundledBuildId();
    const versionDir = path.join(versionsDir, buildId);
    const exePath = path.join(versionDir, path.basename(bundledExe));
    if (!(await exists(exePath))) {
      // Copy beside, then rename, so a half-copied folder is never used.
      const partial = `${versionDir}.partial`;
      await fsp.rm(partial, { recursive: true, force: true });
      await fsp.mkdir(partial, { recursive: true });
      // Only what the worker runs: the executable and its tools. The bundle
      // also ships a second, identical executable under another name.
      await fsp.copyFile(bundledExe, path.join(partial, path.basename(bundledExe)));
      const toolsDir = path.join(path.dirname(bundledExe), 'worker-tools');
      if (await exists(toolsDir)) {
        await fsp.cp(toolsDir, path.join(partial, 'worker-tools'), { recursive: true });
      }
      await fsp.rm(versionDir, { recursive: true, force: true });
      await fsp.rename(partial, versionDir);
    }
    return { buildId, exePath };
  }

  private async writeDeploymentRecord(record: DeploymentRecord): Promise<void> {
    const { root, deploymentPath } = this.paths();
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(deploymentPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private async readDeployment(): Promise<DeploymentRecord | null> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.paths().deploymentPath, 'utf8')) as Partial<DeploymentRecord>;
      return typeof raw.buildId === 'string' && typeof raw.exePath === 'string'
        ? { buildId: raw.buildId, exePath: raw.exePath }
        : null;
    } catch {
      return null;
    }
  }

  private async writeLauncher(exePath: string, configPath: string): Promise<void> {
    const { root, launcherPath } = this.paths();
    await fsp.mkdir(root, { recursive: true });
    // UTF-16LE with a BOM: Windows Script Host reads that as Unicode, so a
    // user name with non-ASCII letters in the path survives.
    const content = buildHiddenLauncherScript(exePath, configPath).replace(/\n/g, '\r\n');
    await fsp.writeFile(launcherPath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(content, 'utf16le'),
    ]));
  }

  private async registerTask(): Promise<void> {
    const { launcherPath, root } = this.paths();
    await this.ps(buildRegisterTaskScript(launcherPath, root));
  }

  /**
   * End every process running from the private copy (the supervisor and its
   * worker) together with whatever they launched (CLI agents, terminals), and
   * wait for them to go, so the config can be rewritten safely. Processes
   * outside the folder — e.g. a Harness-started worker — are untouched.
   */
  private async stopWorkerProcesses(): Promise<void> {
    const { versionsDir } = this.paths();
    await this.ps(`$ErrorActionPreference = 'Stop'
$root = ${psQuote(`${versionsDir}${path.sep}`)}
$procs = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
})
# Windows PowerShell 5.1 turns a native command's stderr into a terminating
# error under 'Stop'; taskkill reports an already-exited child that way.
$ErrorActionPreference = 'Continue'
foreach ($p in $procs) { & taskkill.exe /PID $p.ProcessId /T /F *> $null }
foreach ($p in $procs) { Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
# A force-killed worker cannot release its single-instance lock. Windows reuses
# PIDs quickly, so a stale lock naming a reused PID would make the next worker
# exit as "already running" (and Harness report it running). Drop the locks
# held by the processes just killed.
$killed = @($procs | ForEach-Object { [string]$_.ProcessId })
if ($killed.Count -gt 0) {
  Get-ChildItem -LiteralPath $env:TEMP -Filter 'orchestrator-worker-*.lock' -ErrorAction SilentlyContinue | ForEach-Object {
    $holder = ([string](Get-Content -LiteralPath $_.FullName -TotalCount 1 -ErrorAction SilentlyContinue)).Trim() -split '\s+' | Select-Object -First 1
    if ($killed -contains $holder) { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  }
}`);
  }

  /** Delete version folders other than `keep`. A folder still in use is skipped. */
  private async pruneVersions(keep: string | null): Promise<void> {
    const { versionsDir } = this.paths();
    let entries: string[];
    try {
      entries = await fsp.readdir(versionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === keep) {
        continue;
      }
      try {
        await fsp.rm(path.join(versionsDir, entry), { recursive: true, force: true });
      } catch (error) {
        logger.warn('Could not remove an old worker copy', {
          entry,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * PowerShell single-quoted literal. PowerShell also treats the typographic
 * single quotes (U+2018-U+201B) as delimiters, so each is doubled too — a
 * Windows user name with a curly apostrophe otherwise ends the string.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote)}'`;
}

function vbsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Disable and end the task; a missing or idle task is fine, other faults are not. */
const RETHROW_UNLESS_NOT_FOUND = "if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }";
const PAUSE_TASK = `try { Disable-ScheduledTask @task | Out-Null } catch { ${RETHROW_UNLESS_NOT_FOUND} }
try { Stop-ScheduledTask @task } catch { }`;

function taskRef(): string {
  return `$ErrorActionPreference = 'Stop'
$task = @{ TaskPath = ${psQuote(SIGN_IN_TASK_PATH)}; TaskName = ${psQuote(SIGN_IN_TASK_NAME)} }`;
}

/**
 * Hidden and BLOCKING (third Run() argument True), exactly like
 * scripts/windows/run-worker-hidden.template.vbs: the task stays "Running"
 * for the worker's lifetime, so IgnoreNew stops the keep-alive starting a
 * second copy, and window style 0 keeps the console off screen.
 */
export function buildHiddenLauncherScript(exePath: string, configPath: string): string {
  return `' Harness Worker Mode: hidden, blocking launcher. Generated by Harness; do not edit.
Option Explicit
Dim shell, q, command
Set shell = CreateObject("WScript.Shell")
q = Chr(34)
command = q & ${vbsQuote(exePath)} & q & " --config " & q & ${vbsQuote(configPath)} & q & " --supervise"
WScript.Quit shell.Run(command, 0, True)
`;
}

/**
 * Two triggers on purpose (see install-worker-launcher.ps1): a repetition
 * hung off the logon trigger stays dormant until the next logon, so the
 * keep-alive gets its own time trigger.
 */
export function buildRegisterTaskScript(launcherPath: string, workingDirectory: string): string {
  return `${taskRef()}
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + ${psQuote(launcherPath)} + '"') -WorkingDirectory ${psQuote(workingDirectory)}
$logon = New-ScheduledTaskTrigger -AtLogOn -User $userId
$keepAlive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${KEEP_ALIVE_MINUTES})
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
Register-ScheduledTask @task -Action $action -Trigger @($logon, $keepAlive) -Settings $settings -Principal $principal -Description 'Runs the Harness Worker Mode worker when you sign in, even with Harness closed.' -Force | Out-Null`;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function runPowerShellScript(script: string): Promise<string> {
  // -EncodedCommand (UTF-16LE base64) avoids every quoting layer between
  // Node, CreateProcess and PowerShell's own parser.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-OutputFormat',
        'Text',
        '-EncodedCommand',
        encoded,
      ],
      { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Never echo error.message: it holds the whole encoded command line.
          const detail = readablePowerShellError(String(stderr || ''))
            || (error.killed ? 'PowerShell did not finish in time' : `PowerShell exited with code ${String(error.code)}`);
          reject(new Error(`Windows task setup failed: ${detail}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/**
 * PowerShell may report errors as CLIXML ("#< CLIXML" then <S S="Error">
 * elements) when its streams are redirected. Pull out the readable text.
 */
export function readablePowerShellError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed.startsWith('#< CLIXML')) {
    return trimmed.slice(0, 500);
  }
  const lines = [...trimmed.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => match[1]!
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'))
    .join('')
    .trim();
  return lines.slice(0, 500);
}

let workerSignInTask: WorkerSignInTask | null = null;

export function getWorkerSignInTask(): WorkerSignInTask {
  workerSignInTask ??= new WorkerSignInTask();
  return workerSignInTask;
}

export function _resetWorkerSignInTaskForTesting(): void {
  workerSignInTask = null;
}
