import { describe, it, expect } from 'vitest';
import { DestructiveValidator } from '../validators/destructive-validator';
import { CommandParser } from '../command-parser';
import type { ValidationContext } from '../types';

const validator = new DestructiveValidator();
const parser = new CommandParser();
const ctx: ValidationContext = {
  mode: 'prompt', workspacePath: '/workspace', instanceDepth: 0, yoloMode: false, instanceId: 'test',
};

function check(cmd: string) {
  return validator.validate(cmd, parser.parse(cmd), ctx);
}

describe('DestructiveValidator', () => {
  describe('always-blocked commands', () => {
    it.each([
      'mkfs /dev/sda', 'mkfs.ext4 /dev/sda', 'mkfs.xfs /dev/sda', 'mkfs.btrfs /dev/sda',
      'fdisk /dev/sda', 'parted /dev/sda',
      'shutdown now', 'reboot', 'halt', 'poweroff', 'init 0',
      'chroot /mnt', 'passwd root',
      'usermod -aG wheel user', 'useradd testuser', 'userdel testuser',
      'groupmod testgroup', 'groupadd testgroup', 'groupdel testgroup',
      'shred file.txt', 'wipefs /dev/sda',
      'xmrig --pool pool.example.com', 'cpuminer -o stratum+tcp://pool', 'minerd -a sha256',
    ])('blocks "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('blocked patterns', () => {
    it.each([
      'rm -rf /', 'rm -fr /', 'rm -rf /*',
      'rm -rf / --no-preserve-root', 'rm --no-preserve-root -rf /',
      'rm -rf ~', 'rm -rf $HOME',
      'rm /',
    ])('blocks "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });

    it.each([
      'dd if=/dev/zero of=/dev/sda', 'dd if=/dev/zero of=/dev/hda',
      'dd if=/dev/zero of=/dev/nvme0n1', 'dd if=/dev/zero of=/dev/vda',
      'dd if=malware of=/dev/sda',
    ])('blocks dd to disk: "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });

    it('blocks fork bombs', () => {
      expect(check(':(){:|:&};:').action).toBe('block');
    });

    it.each([
      'chmod +s /bin/bash', 'chmod u+s /bin/sh',
      'chmod -R 777 /', 'chmod -R 000 /',
    ])('blocks "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('warn patterns', () => {
    it.each([
      'rm -rf *', 'rm -rf .', 'rm -rf ../*',
      'rm -rf /home/user',
    ])('warns on "%s"', (cmd) => {
      expect(check(cmd).action).toBe('warn');
    });

    it('warns on recursive chmod to system directories', () => {
      expect(check('chmod -R 777 /usr').action).toBe('warn');
    });

    it('warns on recursive chown to root paths', () => {
      expect(check('chown -R root /usr').action).toBe('warn');
    });
  });

  describe('safe commands', () => {
    it.each([
      'ls -la', 'cat file.txt', 'rm file.txt', 'rm -f temp.log',
      'dd if=input.img of=output.img bs=4096',
      'chmod 755 script.sh',
    ])('allows "%s"', (cmd) => {
      expect(check(cmd).action).toBe('allow');
    });
  });
});
