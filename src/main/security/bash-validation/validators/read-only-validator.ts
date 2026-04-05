import type { BashValidatorSubmodule, ParsedCommand, ValidationContext, SubmoduleResult } from '../types';

const WRITE_COMMANDS = new Set([
  'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'chgrp', 'ln',
  'install', 'tee', 'truncate', 'shred', 'mkfifo', 'mknod', 'dd',
]);

const STATE_MODIFYING_COMMANDS = new Set([
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'pip', 'pip3', 'npm', 'yarn',
  'pnpm', 'bun', 'cargo', 'gem', 'go', 'rustup', 'docker', 'podman',
  'systemctl', 'service', 'mount', 'umount',
  'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt', 'poweroff',
  'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel',
  'crontab', 'at',
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'fetch',
  'ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'describe',
  'shortlog', 'blame', 'bisect', 'reflog',
]);

export class ReadOnlyValidator implements BashValidatorSubmodule {
  readonly name = 'ReadOnlyValidator';

  validate(raw: string, parsed: ParsedCommand, context: ValidationContext): SubmoduleResult {
    if (context.mode !== 'read_only') {
      return { action: 'allow' };
    }

    for (const seg of parsed.segments) {
      if (seg.redirects.some(r => /^>/.test(r.trim()))) {
        return { action: 'block', reason: 'Write redirection blocked in read-only mode', submodule: this.name };
      }

      const cmd = seg.mainCommand;

      if (cmd === 'git') {
        const subCmd = seg.arguments[0] || '';
        if (!SAFE_GIT_SUBCOMMANDS.has(subCmd)) {
          return { action: 'block', reason: `git ${subCmd} blocked in read-only mode`, submodule: this.name };
        }
        continue;
      }

      if (WRITE_COMMANDS.has(cmd)) {
        return { action: 'block', reason: `Write command '${cmd}' blocked in read-only mode`, submodule: this.name };
      }

      if (STATE_MODIFYING_COMMANDS.has(cmd)) {
        return { action: 'block', reason: `State-modifying command '${cmd}' blocked in read-only mode`, submodule: this.name };
      }
    }

    return { action: 'allow' };
  }
}
