import type { BashValidatorSubmodule, ParsedCommand, SubmoduleResult } from '../types';

const ALWAYS_BLOCKED = new Set([
  'mkfs', 'fdisk', 'parted',
  'init', 'shutdown', 'reboot', 'halt', 'poweroff',
  'chroot', 'passwd', 'usermod', 'useradd', 'userdel',
  'groupmod', 'groupadd', 'groupdel',
  'shred', 'wipefs',
  'xmrig', 'cpuminer', 'minerd',
]);

interface PatternRule {
  pattern: RegExp;
  message: string;
}

const BLOCK_PATTERNS: PatternRule[] = [
  { pattern: /\brm\s+(-[rRfv]+\s+)+\/(\*)?($|\s)/, message: 'Recursive removal of root filesystem' },
  { pattern: /\brm\b.*--no-preserve-root/, message: 'rm with --no-preserve-root' },
  { pattern: /\brm\s+(-[rRfv]+\s+)+(~|\$HOME)($|\s)/, message: 'Recursive removal of home directory' },
  { pattern: /\brm\s+\/$/, message: 'rm of root directory' },
  { pattern: /\bdd\b.*\bof=\/dev\/(sd|hd|nvme|vd)/, message: 'dd targeting disk device' },
  { pattern: />\s*\/dev\/(sd|hd|nvme|vd)/, message: 'Redirect to disk device' },
  { pattern: />\s*\/boot\//, message: 'Redirect to boot partition' },
  { pattern: /:\(\)\{.*:\|:.*\}/, message: 'Fork bomb detected' },
  { pattern: /\.\(\)\{.*\.\|\..*\}/, message: 'Fork bomb variant detected' },
  { pattern: /chmod\s+[+u]?[+]?s\s+\/bin\/(ba)?sh/, message: 'SUID bit on shell binary' },
  { pattern: /chmod\s+[+u]?[+]?s\s+\/usr\/bin\/(ba)?sh/, message: 'SUID bit on shell binary' },
  { pattern: /chmod\s+-R\s+777\s+\/$/, message: 'World-writable root filesystem' },
  { pattern: /chmod\s+-R\s+777\s+\/\s/, message: 'World-writable root filesystem' },
  { pattern: /chmod\s+-R\s+000\s+\//, message: 'Remove all permissions from root' },
];

const WARN_PATTERNS: PatternRule[] = [
  { pattern: /\brm\s+(-[rRfv]+\s+)+\*($|\s)/, message: 'Recursive removal of current directory contents' },
  { pattern: /\brm\s+(-[rRfv]+\s+)+\.($|\s)/, message: 'Recursive removal of current directory' },
  { pattern: /\brm\s+(-[rRfv]+\s+)+\.\.\//, message: 'Recursive removal of parent directory' },
  { pattern: /\brm\s+(-[rRfv]+\s+)+\/\w/, message: 'Recursive removal of absolute path' },
  { pattern: /chmod\s+-R\s+\d+\s+\//, message: 'Recursive permission change on root path' },
  { pattern: /chown\s+-R\s+\S+\s+\//, message: 'Recursive ownership change on root path' },
];

export class DestructiveValidator implements BashValidatorSubmodule {
  readonly name = 'DestructiveValidator';

  validate(raw: string, parsed: ParsedCommand): SubmoduleResult {
    for (const rule of BLOCK_PATTERNS) {
      if (rule.pattern.test(raw)) {
        return { action: 'block', reason: rule.message, submodule: this.name };
      }
    }

    for (const seg of parsed.segments) {
      const cmd = seg.mainCommand;
      if (ALWAYS_BLOCKED.has(cmd) || cmd.startsWith('mkfs.')) {
        return { action: 'block', reason: `Command '${cmd}' is blocked for safety`, submodule: this.name };
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
