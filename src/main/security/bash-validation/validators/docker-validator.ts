import type { BashValidatorSubmodule, ParsedCommand, ValidationContext, SubmoduleResult } from '../types';

interface PatternRule { pattern: RegExp; message: string; }

const BLOCK_PATTERNS: PatternRule[] = [
  { pattern: /(?:docker|podman)\s+run\s+.*--privileged/, message: 'Privileged container (full host access)' },
  { pattern: /(?:docker|podman)\s+run\s+.*--cap-add=ALL/, message: 'Container with all capabilities' },
  { pattern: /(?:docker|podman)\s+run\s+.*--cap-add=SYS_ADMIN/, message: 'Container with SYS_ADMIN (cgroup escape)' },
  { pattern: /(?:docker|podman)\s+run\s+.*-v\s+\/:/, message: 'Host root mount into container' },
  { pattern: /(?:docker|podman)\s+run\s+.*-v\s+\/etc\//, message: 'Host /etc mount into container' },
  { pattern: /(?:docker|podman)\s+run\s+.*-v\s+\/var\/run\/docker\.sock/, message: 'Docker socket mount (escape)' },
  { pattern: /(?:docker|podman)\s+run\s+.*-v\s+~\/\.ssh/, message: 'SSH key mount into container' },
  { pattern: /\bnsenter\b/, message: 'nsenter namespace escape' },
];

const WARN_PATTERNS: PatternRule[] = [
  { pattern: /(?:docker|podman)\s+run\s+.*--pid=host/, message: 'Host PID namespace' },
  { pattern: /(?:docker|podman)\s+run\s+.*--network=host/, message: 'Host network namespace' },
  { pattern: /(?:docker|podman)\s+exec\s+.*-u\s+root/, message: 'Root execution in container' },
  { pattern: /(?:docker|podman)\s+cp\s+\S+\s+\S+:\//, message: 'File injection into container' },
];

export class DockerValidator implements BashValidatorSubmodule {
  readonly name = 'DockerValidator';

  validate(raw: string, parsed: ParsedCommand, _context: ValidationContext): SubmoduleResult {
    const hasDocker = parsed.segments.some(s =>
      ['docker', 'podman', 'nsenter'].includes(s.mainCommand)
    );
    if (!hasDocker && !/\bnsenter\b/.test(raw)) return { action: 'allow' };

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
