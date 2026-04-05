import type { BashValidatorSubmodule, ParsedCommand, SubmoduleResult } from '../types';

const ALWAYS_BLOCKED = new Set(['nmap', 'netcat', 'nc']);

interface PatternRule {
  pattern: RegExp;
  message: string;
}

const BLOCK_PATTERNS: PatternRule[] = [
  { pattern: /\/dev\/tcp\//, message: 'Bash /dev/tcp reverse shell' },
  { pattern: /\/dev\/udp\//, message: 'Bash /dev/udp reverse shell' },
  { pattern: /\bnc\b.*-e\s+\/bin\//, message: 'Netcat reverse shell' },
  { pattern: /\bncat\b.*(-e|--sh-exec)/, message: 'Ncat reverse shell' },
  { pattern: /\bsocat\b.*exec:.*tcp/, message: 'Socat reverse shell' },
  { pattern: /\bsocat\b.*tcp.*exec:/, message: 'Socat reverse shell' },
  { pattern: /\bngrok\b/, message: 'Tunnel tool: ngrok' },
  { pattern: /\blocaltunnel\b/, message: 'Tunnel tool: localtunnel' },
  { pattern: /\bbore\b\s+(local|server)/, message: 'Tunnel tool: bore' },
  { pattern: /\bcloudflared\s+tunnel\b/, message: 'Tunnel tool: cloudflared' },
];

const WARN_PATTERNS: PatternRule[] = [
  { pattern: /curl\s+.*-[dF]\s+.*@/, message: 'HTTP POST with file data (potential exfiltration)' },
  { pattern: /curl\s+.*-X\s+POST\s+.*-d\s+@/, message: 'HTTP POST with file data' },
  { pattern: /wget\s+--post-file/, message: 'wget POST with file data' },
  { pattern: /scp\s+\S+\s+\S+@\S+:/, message: 'File copy to remote host' },
  { pattern: /rsync\s+.*\S+@\S+:/, message: 'File sync to remote host' },
  { pattern: /\bdig\b.*\$\(/, message: 'Command substitution in DNS query' },
  { pattern: /\bnslookup\b.*\$\(/, message: 'Command substitution in DNS lookup' },
  { pattern: /\bhost\b.*\$\(/, message: 'Command substitution in host lookup' },
  { pattern: /ssh\s+-R\b/, message: 'SSH reverse tunnel' },
  { pattern: /ssh\s+-L\b/, message: 'SSH local tunnel' },
  { pattern: /ssh\s+-D\b/, message: 'SSH dynamic/SOCKS proxy' },
];

export class NetworkValidator implements BashValidatorSubmodule {
  readonly name = 'NetworkValidator';

  validate(raw: string, parsed: ParsedCommand): SubmoduleResult {
    for (const seg of parsed.segments) {
      if (ALWAYS_BLOCKED.has(seg.mainCommand)) {
        return { action: 'block', reason: `Network tool '${seg.mainCommand}' is blocked`, submodule: this.name };
      }
    }

    for (const rule of BLOCK_PATTERNS) {
      if (rule.pattern.test(raw)) {
        return { action: 'block', reason: rule.message, submodule: this.name };
      }
    }

    for (const rule of WARN_PATTERNS) {
      if (rule.pattern.test(raw)) {
        return { action: 'warn', message: rule.message, submodule: this.name };
      }
    }

    return { action: 'allow' };
  }
}
