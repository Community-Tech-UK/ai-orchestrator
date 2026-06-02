import * as os from 'os';
import { execFileSync } from 'child_process';

/**
 * Returns all non-internal IPv4 addresses on this machine.
 * Useful for showing workers which IP to connect to.
 */
export function getLocalIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];

  for (const values of Object.values(interfaces)) {
    for (const iface of values || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }

  return ips;
}

export function getTailscaleIpv4Address(): string | null {
  return getLocalIpv4Addresses().find((ip) => isTailscaleIpv4Address(ip)) ?? null;
}

export function getTailscaleMagicDnsName(): string | null {
  for (const command of getTailscaleCommandCandidates()) {
    try {
      const statusJson = execFileSync(command, ['status', '--json', '--self'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 750,
      });
      const dnsName = getTailscaleDnsNameFromStatusJson(statusJson);
      if (dnsName) {
        return dnsName;
      }
    } catch {
      // Tailscale CLI may be absent or not running; fall back to interface IP.
    }
  }

  return null;
}

export function getTailscaleDnsNameFromStatusJson(statusJson: string): string | null {
  try {
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
    const dnsName = typeof parsed.Self?.DNSName === 'string'
      ? parsed.Self.DNSName.trim().replace(/\.$/, '')
      : '';
    return dnsName || null;
  } catch {
    return null;
  }
}

export function isTailscaleIpv4Address(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function getTailscaleCommandCandidates(): string[] {
  const candidates = ['tailscale'];

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
    );
  }

  if (process.platform === 'win32') {
    candidates.push(
      `${process.env['ProgramFiles'] ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`,
      `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Tailscale\\tailscale.exe`,
    );
  }

  return [...new Set(candidates)];
}
