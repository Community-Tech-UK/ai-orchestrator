import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileCapture, ExecFileError } from './exec-file';
import { generateWinswXml } from './windows-winsw-xml';
import { servicePaths } from './paths';
import type { ServiceManager, ServiceInstallOptions, ServiceStatus } from './types';

const SERVICE_ID = 'ai-orchestrator-worker';
const DISPLAY_NAME = 'AI Orchestrator Worker';

export class WindowsServiceManager implements ServiceManager {
  async install(opts: ServiceInstallOptions): Promise<void> {
    const paths = servicePaths('win32');
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await fs.mkdir(paths.configDir, { recursive: true });

    const winswExe = path.join(paths.binDir, `${SERVICE_ID}.exe`);
    const winswXml = path.join(paths.binDir, `${SERVICE_ID}.xml`);

    // Copy SEA binary to final location
    const targetBin = path.join(paths.binDir, 'worker-agent.exe');
    await fs.copyFile(opts.binaryPath, targetBin);

    // Copy bundled WinSW shim (renamed to the service id)
    const bundledWinsw = path.resolve(__dirname, '..', '..', '..', 'resources', 'winsw', 'WinSW-x64.exe');
    await fs.copyFile(bundledWinsw, winswExe);

    const xml = generateWinswXml({
      serviceId: SERVICE_ID,
      displayName: DISPLAY_NAME,
      description: 'AI Orchestrator worker node',
      executable: targetBin,
      arguments: ['--service-run', '--config', opts.configPath],
      logDir: opts.logDir ?? paths.logDir,
      serviceAccount: opts.serviceAccount ?? 'NT SERVICE\\' + SERVICE_ID,
    });
    await fs.writeFile(winswXml, xml, 'utf8');

    await execFileCapture(winswExe, ['install']);
    await execFileCapture(winswExe, ['start']);
    await this.grantStartStopAcl();
  }

  async uninstall(): Promise<void> {
    const paths = servicePaths('win32');
    const winswExe = path.join(paths.binDir, `${SERVICE_ID}.exe`);
    try {
      await execFileCapture(winswExe, ['stop']);
    } catch {
      // ignore — may already be stopped
    }
    await execFileCapture(winswExe, ['uninstall']);
  }

  async start(): Promise<void> {
    await execFileCapture('sc.exe', ['start', SERVICE_ID]);
  }

  async stop(): Promise<void> {
    await execFileCapture('sc.exe', ['stop', SERVICE_ID]);
  }

  async restart(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // tolerate already-stopped
    }
    await this.start();
  }

  async status(): Promise<ServiceStatus> {
    try {
      const { stdout } = await execFileCapture('sc.exe', ['queryex', SERVICE_ID]);
      const stateMatch = stdout.match(/STATE\s*:\s*\d+\s+(\w+)/);
      const pidMatch = stdout.match(/PID\s*:\s*(\d+)/);
      const rawState = stateMatch?.[1] ?? '';
      const state = rawState === 'RUNNING' ? 'running' : rawState === 'STOPPED' ? 'stopped' : 'unknown';
      return {
        state,
        pid: pidMatch ? Number(pidMatch[1]) : undefined,
      };
    } catch (e) {
      if (e instanceof ExecFileError && e.stderr.includes('1060')) {
        return { state: 'not-installed' };
      }
      throw e;
    }
  }

  async isInstalled(): Promise<boolean> {
    const s = await this.status();
    return s.state !== 'not-installed';
  }

  private async grantStartStopAcl(): Promise<void> {
    // Query current SDDL
    const { stdout } = await execFileCapture('sc.exe', ['sdshow', SERVICE_ID]);
    const current = stdout.trim();
    // Grant Authenticated Users RP (start) + WP (stop)
    const aceFragment = '(A;;RPWPCR;;;AU)';
    if (current.includes(aceFragment)) return;
    const daclStart = current.indexOf('D:');
    if (daclStart < 0) return;
    const sControlEnd = current.indexOf('S:', daclStart);
    const before = current.slice(0, sControlEnd >= 0 ? sControlEnd : current.length);
    const after = sControlEnd >= 0 ? current.slice(sControlEnd) : '';
    const updated = before + aceFragment + after;
    await execFileCapture('sc.exe', ['sdset', SERVICE_ID, updated]);
  }
}
