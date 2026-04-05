import type { BashValidatorSubmodule, ParsedCommand, SubmoduleResult } from '../types';

const BUILD_TOOLS = new Set(['make', 'gradle', 'mvn']);

const SAFE_NPM_SUBCOMMANDS = new Set([
  'test', 'run', 'start', 'build', 'list', 'ls', 'outdated', 'audit',
  'info', 'view', 'config', 'cache', 'pack', 'link', 'unlink', 'ci',
  'dedupe', 'explain', 'fund', 'prune', 'shrinkwrap',
]);

const SAFE_PIP_SUBCOMMANDS = new Set([
  'list', 'freeze', 'show', 'check', 'config', 'cache', 'debug', 'inspect',
]);

export class PackageValidator implements BashValidatorSubmodule {
  readonly name = 'PackageValidator';

  validate(raw: string, parsed: ParsedCommand): SubmoduleResult {
    // Block: piped remote install
    if (/\bcurl\b.*\|\s*pip\s+install\b/.test(raw) || /\bwget\b.*&&\s*pip\s+install\b/.test(raw)) {
      return { action: 'block', reason: 'Piped remote package install', submodule: this.name };
    }

    // Block: pip install --install-option
    if (/pip3?\s+install\s+.*--install-option/.test(raw)) {
      return { action: 'block', reason: 'pip install with --install-option (arbitrary hooks)', submodule: this.name };
    }

    for (const seg of parsed.segments) {
      const cmd = seg.mainCommand;
      const args = seg.arguments;
      const subCmd = args[0] || '';

      // npx: always warn (arbitrary package execution)
      if (cmd === 'npx') {
        return { action: 'warn', message: 'npx runs arbitrary package code', submodule: this.name };
      }

      // Build tools: warn
      if (BUILD_TOOLS.has(cmd)) {
        return { action: 'warn', message: `Build tool '${cmd}' may run arbitrary targets`, submodule: this.name };
      }

      // npm/yarn/pnpm
      if (cmd === 'npm' || cmd === 'yarn' || cmd === 'pnpm') {
        if (SAFE_NPM_SUBCOMMANDS.has(subCmd)) continue;

        // npm publish
        if (subCmd === 'publish') {
          return { action: 'warn', message: 'Package publication', submodule: this.name };
        }

        // npm install with no args or `.` → installing from lockfile/local → safe
        if (subCmd === 'install' || subCmd === 'add' || subCmd === 'i') {
          const installArgs = args.slice(1);
          if (installArgs.length === 0 || installArgs.every(a => a === '.' || a.startsWith('-'))) {
            continue;
          }
          if (installArgs.includes('-g') || installArgs.includes('--global')) {
            return { action: 'warn', message: 'Global package install', submodule: this.name };
          }
          return { action: 'warn', message: `Package install: ${cmd} ${subCmd}`, submodule: this.name };
        }
      }

      // pip/pip3
      if (cmd === 'pip' || cmd === 'pip3') {
        if (SAFE_PIP_SUBCOMMANDS.has(subCmd)) continue;

        if (subCmd === 'install') {
          const installArgs = args.slice(1);
          // Allow: pip install . | pip install -r file | pip install -flags
          // Safe if: empty args, only dots and flags, or has -r/-r requirements file
          if (installArgs.length === 0) continue;

          // Check if we have -r or --requirement flags (safe, installing from file)
          const hasRequirementsFlag = installArgs.some((arg) => {
            return (arg === '-r' || arg === '--requirement' || arg.startsWith('--requirement='));
          });
          if (hasRequirementsFlag) continue;

          // Otherwise, safe only if all are dots or flags
          if (installArgs.every(a => a === '.' || a.startsWith('-'))) continue;

          return { action: 'warn', message: 'pip install of named package', submodule: this.name };
        }
      }

      // cargo/gem install
      if ((cmd === 'cargo' || cmd === 'gem') && subCmd === 'install') {
        const installArgs = args.slice(1);
        if (installArgs.length > 0 && !installArgs.every(a => a.startsWith('-'))) {
          return { action: 'warn', message: `${cmd} install of named package`, submodule: this.name };
        }
      }
    }

    return { action: 'allow' };
  }
}
