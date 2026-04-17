import * as fs from 'node:fs/promises';
import { execFileCapture, ExecFileError } from './exec-file';
import { generateLaunchdPlist } from './macos-launchd-plist';
import { servicePaths } from './paths';
import type { ServiceManager, ServiceInstallOptions, ServiceStatus } from './types';

const LABEL = 'com.aiorchestrator.worker';
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;
const SERVICE_TARGET = `system/${LABEL}`;
const USER_NAME = '_orchestrator';
const GROUP_NAME = '_orchestrator';

export class MacosServiceManager implements ServiceManager {
  async install(opts: ServiceInstallOptions): Promise<void> {
    const paths = servicePaths('darwin');
    await this.ensureServiceUser();
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await fs.mkdir('/usr/local/var/orchestrator', { recursive: true });
    await fs.copyFile(opts.binaryPath, paths.binFile);
    await fs.chmod(paths.binFile, 0o755);
    await execFileCapture('chown', ['root:wheel', paths.binFile]);
    await execFileCapture('chown', [
      '-R',
      `${USER_NAME}:${GROUP_NAME}`,
      paths.logDir,
      '/usr/local/var/orchestrator',
    ]);

    const xml = generateLaunchdPlist({
      label: LABEL,
      programArguments: [paths.binFile, '--service-run', '--config', opts.configPath],
      userName: USER_NAME,
      groupName: GROUP_NAME,
      stdoutPath: `${paths.logDir}/worker.out.log`,
      stderrPath: `${paths.logDir}/worker.err.log`,
      workingDirectory: '/usr/local/var/orchestrator',
    });
    await fs.writeFile(PLIST_PATH, xml, { mode: 0o644 });
    await execFileCapture('chown', ['root:wheel', PLIST_PATH]);

    await execFileCapture('launchctl', ['bootstrap', 'system', PLIST_PATH]);
    await execFileCapture('launchctl', ['kickstart', '-k', SERVICE_TARGET]);
    await this.installSudoersDropIn();
  }

  async uninstall(): Promise<void> {
    try {
      await execFileCapture('launchctl', ['bootout', SERVICE_TARGET]);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(PLIST_PATH);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink('/etc/sudoers.d/orchestrator');
    } catch {
      /* ignore */
    }
  }

  async start(): Promise<void> {
    await execFileCapture('launchctl', ['kickstart', SERVICE_TARGET]);
  }

  async stop(): Promise<void> {
    await execFileCapture('launchctl', ['kill', 'SIGTERM', SERVICE_TARGET]);
  }

  async restart(): Promise<void> {
    await execFileCapture('launchctl', ['kickstart', '-k', SERVICE_TARGET]);
  }

  async status(): Promise<ServiceStatus> {
    try {
      const { stdout } = await execFileCapture('launchctl', ['print', SERVICE_TARGET]);
      const stateMatch = stdout.match(/state\s*=\s*(\w+)/);
      const pidMatch = stdout.match(/pid\s*=\s*(\d+)/);
      const st = stateMatch?.[1];
      const state =
        st === 'running'
          ? 'running'
          : st === 'not running' || st === 'exited'
            ? 'stopped'
            : 'unknown';
      return { state, pid: pidMatch ? Number(pidMatch[1]) : undefined };
    } catch (e) {
      if (e instanceof ExecFileError && /Could not find service/i.test(e.stderr)) {
        return { state: 'not-installed' };
      }
      throw e;
    }
  }

  async isInstalled(): Promise<boolean> {
    const s = await this.status();
    return s.state !== 'not-installed';
  }

  private async ensureServiceUser(): Promise<void> {
    try {
      await execFileCapture('dscl', ['.', '-read', `/Users/${USER_NAME}`]);
      return;
    } catch {
      /* create below */
    }
    const uid = await this.nextAvailableUid();
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`]);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'UserShell', '/usr/bin/false']);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'RealName', 'AI Orchestrator Worker']);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'UniqueID', String(uid)]);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'PrimaryGroupID', String(uid)]);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'NFSHomeDirectory', '/var/empty']);
  }

  private async nextAvailableUid(): Promise<number> {
    const { stdout } = await execFileCapture('dscl', ['.', '-list', '/Users', 'UniqueID']);
    let max = 200;
    for (const line of stdout.split('\n')) {
      const m = line.match(/\s(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (n < 500 && n > max) max = n;
      }
    }
    return max + 1;
  }

  private async installSudoersDropIn(): Promise<void> {
    const content = `# Allow admin group to manage AI Orchestrator worker daemon
%admin ALL=(root) NOPASSWD: /bin/launchctl kickstart system/${LABEL}
%admin ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/${LABEL}
%admin ALL=(root) NOPASSWD: /bin/launchctl kill SIGTERM system/${LABEL}
%admin ALL=(root) NOPASSWD: /bin/launchctl print system/${LABEL}
`;
    const tmp = '/etc/sudoers.d/.orchestrator.tmp';
    await fs.writeFile(tmp, content, { mode: 0o440 });
    await execFileCapture('chown', ['root:wheel', tmp]);
    await execFileCapture('visudo', ['-c', '-f', tmp]);
    await fs.rename(tmp, '/etc/sudoers.d/orchestrator');
  }
}
