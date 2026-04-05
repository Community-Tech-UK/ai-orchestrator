import type { CommandIntent, CommandSegment } from './types';

const READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'echo', 'pwd', 'cd', 'which',
  'type', 'file', 'stat', 'wc', 'sort', 'uniq', 'diff', 'less', 'more', 'man',
  'help', 'date', 'cal', 'whoami', 'hostname', 'uname', 'env', 'printenv',
  'tree', 'du', 'df', 'free', 'top', 'ps', 'id', 'groups', 'test', 'true', 'false',
  'basename', 'dirname', 'realpath', 'readlink', 'tee', 'seq', 'yes', 'rev',
  'tr', 'cut', 'paste', 'join', 'comm', 'expand', 'unexpand', 'fold', 'fmt',
  'nl', 'od', 'xxd', 'hexdump', 'strings', 'md5sum', 'sha256sum', 'cksum',
]);

const WRITE_COMMANDS = new Set([
  'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'chgrp', 'ln',
  'install', 'truncate', 'mkfifo', 'mknod',
]);

const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'shred', 'wipefs', 'mkfs', 'fdisk', 'parted', 'dd',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init',
]);

const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp', 'sftp', 'telnet',
  'nc', 'netcat', 'ncat', 'socat', 'nmap', 'dig', 'nslookup', 'host', 'ping',
]);

const PROCESS_COMMANDS = new Set([
  'kill', 'pkill', 'killall', 'bg', 'fg', 'jobs', 'wait', 'nohup', 'disown',
  'screen', 'tmux', 'at', 'crontab', 'systemctl', 'service',
]);

const PACKAGE_COMMANDS = new Set([
  'npm', 'yarn', 'pnpm', 'bun', 'npx', 'pip', 'pip3', 'gem', 'cargo',
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'go', 'rustup',
  'make', 'gradle', 'mvn',
]);

const SYSTEM_ADMIN_COMMANDS = new Set([
  'passwd', 'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'groupmod',
  'chroot', 'mount', 'umount', 'modprobe', 'insmod', 'rmmod',
  'iptables', 'firewall-cmd', 'ufw', 'sysctl',
]);

const SEVERITY: Record<CommandIntent, number> = {
  read_only: 0,
  unknown: 1,
  write: 2,
  process_management: 3,
  package_management: 4,
  network: 5,
  system_admin: 6,
  destructive: 7,
};

export class IntentClassifier {
  classify(segments: CommandSegment[]): CommandIntent {
    let worst: CommandIntent = 'read_only';
    for (const seg of segments) {
      const intent = this.classifyCommand(seg.mainCommand);
      if (SEVERITY[intent] > SEVERITY[worst]) worst = intent;
    }
    return segments.length === 0 ? 'unknown' : worst;
  }

  classifyCommand(cmd: string): CommandIntent {
    if (DESTRUCTIVE_COMMANDS.has(cmd) || cmd.startsWith('mkfs.')) return 'destructive';
    if (SYSTEM_ADMIN_COMMANDS.has(cmd)) return 'system_admin';
    if (NETWORK_COMMANDS.has(cmd)) return 'network';
    if (PACKAGE_COMMANDS.has(cmd)) return 'package_management';
    if (PROCESS_COMMANDS.has(cmd)) return 'process_management';
    if (WRITE_COMMANDS.has(cmd)) return 'write';
    if (READ_COMMANDS.has(cmd)) return 'read_only';
    return 'unknown';
  }
}
