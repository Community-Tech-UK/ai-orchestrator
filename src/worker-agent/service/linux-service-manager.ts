import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileCapture } from './exec-file';
import { generateSystemdUnit } from './linux-systemd-unit';
import { servicePaths } from './paths';
import type { ServiceManager, ServiceInstallOptions, ServiceStatus } from './types';

const SERVICE_NAME = 'ai-orchestrator-worker.service';
const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const SERVICE_USER = 'orchestrator';
const SERVICE_GROUP = 'orchestrator';

export class LinuxServiceManager implements ServiceManager {
  async install(opts: ServiceInstallOptions): Promise<void> {
    const paths = servicePaths('linux');
    try {
      await execFileCapture('id', [SERVICE_USER]);
    } catch {
      await execFileCapture('useradd', [
        '--system',
        '--no-create-home',
        '--shell',
        '/usr/sbin/nologin',
        SERVICE_USER,
      ]);
    }
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await fs.mkdir('/var/lib/orchestrator', { recursive: true });
    const version = opts.version ?? 'unversioned';
    const versionedDir = path.join(paths.versionedBinDir, version);
    const versionedBin = path.join(versionedDir, 'worker-agent');
    await fs.mkdir(versionedDir, { recursive: true });
    await fs.copyFile(opts.binaryPath, versionedBin);
    await fs.chmod(versionedBin, 0o755);
    try { await fs.unlink(paths.currentBinLink); } catch { /* ignore */ }
    await fs.symlink(versionedDir, paths.currentBinLink, 'dir');
    await execFileCapture('chown', ['-R', `${SERVICE_USER}:${SERVICE_GROUP}`, paths.logDir, '/var/lib/orchestrator']);
    await execFileCapture('chown', ['root:root', versionedBin]);

    const unit = generateSystemdUnit({
      description: 'AI Orchestrator Worker',
      execStart: `${paths.binFile} --service-run --config ${opts.configPath}`,
      user: SERVICE_USER,
      group: SERVICE_GROUP,
      workingDirectory: '/var/lib/orchestrator',
      stateDirectory: 'orchestrator',
      logDirectory: 'orchestrator',
    });
    await fs.writeFile(UNIT_PATH, unit, { mode: 0o644 });
    await execFileCapture('systemctl', ['daemon-reload']);
    await execFileCapture('systemctl', ['enable', SERVICE_NAME]);
    await execFileCapture('systemctl', ['start', SERVICE_NAME]);
    await this.installPolkitRule();
  }

  async uninstall(): Promise<void> {
    try {
      await execFileCapture('systemctl', ['stop', SERVICE_NAME]);
    } catch {
      /* ignore */
    }
    try {
      await execFileCapture('systemctl', ['disable', SERVICE_NAME]);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(UNIT_PATH);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink('/etc/polkit-1/rules.d/50-orchestrator.rules');
    } catch {
      /* ignore */
    }
    await execFileCapture('systemctl', ['daemon-reload']);
  }

  async start(): Promise<void> {
    await execFileCapture('systemctl', ['start', SERVICE_NAME]);
  }

  async stop(): Promise<void> {
    await execFileCapture('systemctl', ['stop', SERVICE_NAME]);
  }

  async restart(): Promise<void> {
    await execFileCapture('systemctl', ['restart', SERVICE_NAME]);
  }

  async status(): Promise<ServiceStatus> {
    const { stdout } = await execFileCapture('systemctl', [
      'show',
      SERVICE_NAME,
      '--property=ActiveState,MainPID,LoadState,ExecMainStartTimestamp',
    ]);
    const map = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
    }
    if (map.get('LoadState') === 'not-found') return { state: 'not-installed' };
    const active = map.get('ActiveState');
    const state =
      active === 'active'
        ? 'running'
        : active === 'inactive' || active === 'failed'
          ? 'stopped'
          : 'unknown';
    const pidStr = map.get('MainPID');
    const pid = pidStr && pidStr !== '0' ? Number(pidStr) : undefined;
    return { state, pid };
  }

  async isInstalled(): Promise<boolean> {
    const s = await this.status();
    return s.state !== 'not-installed';
  }

  private async installPolkitRule(): Promise<void> {
    const rule = `polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "${SERVICE_NAME}" &&
      subject.isInGroup("${SERVICE_GROUP}")) {
    return polkit.Result.YES;
  }
});
`;
    await fs.writeFile('/etc/polkit-1/rules.d/50-orchestrator.rules', rule, { mode: 0o644 });
  }
}
