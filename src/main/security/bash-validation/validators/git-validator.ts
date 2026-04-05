import type { BashValidatorSubmodule, ParsedCommand, ValidationContext, SubmoduleResult } from '../types';

interface PatternRule {
  pattern: RegExp;
  message: string;
}

const BLOCK_PATTERNS: PatternRule[] = [
  { pattern: /git\s+push\s+(-f|--force)\s+\S+\s+(main|master)\b/, message: 'Force push to main/master blocked' },
  { pattern: /git\s+push\s+\S+\s+(main|master)\s+(-f|--force)/, message: 'Force push to main/master blocked' },
  { pattern: /git\s+filter-branch\b/, message: 'git filter-branch is irreversible' },
  { pattern: /git\s+reflog\s+expire\s+--expire=now/, message: 'Permanent reflog deletion' },
  { pattern: /git\s+config\s+core\.pager\s+["'].*[;&|]/, message: 'Shell injection via git pager config' },
  { pattern: /git\s+config\s+alias\.\S+\s+["']!.*/, message: 'Shell alias injection' },
  { pattern: /git\s+clone\s+--config\s+core\.fsmonitor=["']!/, message: 'Clone-time code execution' },
];

const WARN_PATTERNS: PatternRule[] = [
  { pattern: /git\s+push\s+(-f|--force)\b/, message: 'Force push (non-main branch)' },
  { pattern: /git\s+push\s+--force-with-lease\b/, message: 'Force push with lease' },
  { pattern: /git\s+reset\s+--hard\b/, message: 'git reset --hard discards uncommitted changes' },
  { pattern: /git\s+clean\s+-[fdxX]+\b/, message: 'git clean removes untracked files' },
  { pattern: /git\s+checkout\s+--\s+\./, message: 'Discards all unstaged changes' },
  { pattern: /git\s+restore\s+\./, message: 'Discards all unstaged changes' },
  { pattern: /git\s+rebase\b/, message: 'git rebase modifies history' },
  { pattern: /git\s+gc\s+--prune=now/, message: 'Aggressive garbage collection' },
];

export class GitValidator implements BashValidatorSubmodule {
  readonly name = 'GitValidator';

  validate(raw: string, parsed: ParsedCommand, _context: ValidationContext): SubmoduleResult {
    const hasGit = parsed.segments.some(s => s.mainCommand === 'git');
    if (!hasGit) return { action: 'allow' };

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
