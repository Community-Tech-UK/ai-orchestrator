import * as os from 'os';
import { execFileSync } from 'child_process';

export interface LocalIpv4Candidate {
  name: string;
  address: string;
}

/**
 * Interface-name fragments that identify virtual / non-physical adapters
 * (hypervisor switches, container bridges, other-VPN tunnels). Workers on the
 * LAN can almost never reach the host through these, so they are ranked below
 * real physical adapters when auto-advertising the host IP.
 */
const VIRTUAL_INTERFACE_NAME_PATTERNS = [
  /vethernet/i, // Hyper-V / WSL virtual switch (Windows)
  /hyper-?v/i,
  /default switch/i, // Hyper-V "Default Switch"
  /vmware/i,
  /vmnet/i,
  /virtualbox/i,
  /\bvbox\b/i,
  /docker/i,
  /\bbr-/i, // docker/linux bridges
  /\bwsl\b/i,
  /\bzt\b/i, // ZeroTier
  /zerotier/i,
  /hamachi/i,
  /\btun\d*\b/i, // generic VPN tunnels (non-Tailscale)
  /\btap\d*\b/i,
  /loopback/i,
  /bluetooth/i,
];

export function isLinkLocalIpv4Address(address: string): boolean {
  return /^169\.254\./.test(address);
}

export function isVirtualInterfaceName(name: string): boolean {
  return VIRTUAL_INTERFACE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Lower score = higher priority. Used to push the host's real physical LAN
 * address to the front of the list so auto-discovery advertises a reachable IP
 * instead of whatever adapter the OS happened to enumerate first.
 */
export function scoreLocalIpv4Candidate({ name, address }: LocalIpv4Candidate): number {
  let score = 0;

  // Tailscale CGNAT addresses are surfaced separately via getTailscaleIpv4Address();
  // never auto-pick them as the plain LAN address.
  if (isTailscaleIpv4Address(address)) {
    score += 4000;
  } else if (isVirtualInterfaceName(name)) {
    score += 2000;
  }

  // Prefer the most common physical LAN ranges, in a stable order.
  if (/^192\.168\./.test(address)) {
    score += 0;
  } else if (/^10\./.test(address)) {
    score += 10;
  } else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) {
    score += 20;
  } else {
    // Public or otherwise unexpected addresses rank last among "real" adapters.
    score += 100;
  }

  return score;
}

/**
 * Ranks IPv4 candidates best-first: real physical LAN adapters ahead of virtual
 * adapters and Tailscale CGNAT, link-local (APIPA 169.254.x.x) excluded. Order
 * is stable, so equally-scored candidates keep their OS enumeration order.
 */
export function rankLocalIpv4Candidates(candidates: LocalIpv4Candidate[]): string[] {
  return candidates
    .filter((candidate) => !isLinkLocalIpv4Address(candidate.address))
    .map((candidate, index) => ({
      address: candidate.address,
      index,
      score: scoreLocalIpv4Candidate(candidate),
    }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.address);
}

function collectLocalIpv4Candidates(): LocalIpv4Candidate[] {
  const interfaces = os.networkInterfaces();
  const candidates: LocalIpv4Candidate[] = [];

  for (const [name, values] of Object.entries(interfaces)) {
    for (const iface of values || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }

  return candidates;
}

/**
 * Returns this machine's non-internal IPv4 addresses, ranked best-first for
 * advertising to workers: real physical LAN adapters lead, virtual adapters and
 * Tailscale CGNAT trail, and link-local (APIPA) addresses are dropped. Callers
 * that just want the best single address should take the first element.
 */
export function getLocalIpv4Addresses(): string[] {
  return rankLocalIpv4Candidates(collectLocalIpv4Candidates());
}

export function getTailscaleIpv4Address(): string | null {
  return collectLocalIpv4Candidates()
    .map((candidate) => candidate.address)
    .find((ip) => isTailscaleIpv4Address(ip)) ?? null;
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
