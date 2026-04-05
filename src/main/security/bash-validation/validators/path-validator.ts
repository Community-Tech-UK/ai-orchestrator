import type { BashValidatorSubmodule, SubmoduleResult } from '../types';

// Block patterns: symlink attacks, mount attacks, RC file writes, SSH key injection
const BLOCK_PATTERNS = [
  // Symlink attacks: ln -s <system-path> <workspace-path>
  // Matches: ln -s / or ln -s /etc or ln -s /any/system/path
  /\bln\s+-s\s+\//,
  // Mount attacks: mount --bind <system-path> <workspace-path>
  // Matches: mount --bind / or mount --bind /etc or mount --bind /any/system/path
  /\bmount\s+--bind\s+\//,
  // RC file writes (shell config injection)
  />>?\s*~\/\.(bashrc|zshrc|profile|bash_profile|kshrc|tcshrc)/,
  // SSH key injection: echo "key" >> ~/.ssh/authorized_keys
  />>?\s*~\/\.ssh\/authorized_keys/,
];

// Warn patterns: sensitive directory access, tar extraction, /tmp writes, system directory redirects
const WARN_PATTERNS = [
  // Sensitive directory access
  /~\/\.ssh\//,
  /~\/\.gnupg\//,
  /~\/\.aws\//,
  /~\/\.git\//,
  // /proc/self/environ (environment variable disclosure)
  /\/proc\/self\/environ/,
  // Tar extraction (arbitrary code execution risk)
  /\btar\s+.*-[xX]/,
  // /tmp writes
  />>?\s*\/tmp\//,
  // System directory redirects
  />>?\s*\/(etc|usr|bin|sbin|var)\/\S+/,
];

export class PathValidator implements BashValidatorSubmodule {
  readonly name = 'PathValidator';

  validate(raw: string): SubmoduleResult {
    // Check blocked patterns first
    for (const pattern of BLOCK_PATTERNS) {
      if (pattern.test(raw)) {
        return { action: 'block', reason: 'Blocked path pattern', submodule: this.name };
      }
    }

    // Check warn patterns
    for (const pattern of WARN_PATTERNS) {
      if (pattern.test(raw)) {
        return { action: 'warn', message: 'Sensitive path access', submodule: this.name };
      }
    }

    return { action: 'allow' };
  }
}
