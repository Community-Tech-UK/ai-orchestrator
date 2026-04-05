import { describe, it, expect } from 'vitest';
import { PathValidator } from '../validators/path-validator';
import { CommandParser } from '../command-parser';
import type { ValidationContext } from '../types';

const validator = new PathValidator();
const parser = new CommandParser();
const ctx: ValidationContext = {
  mode: 'prompt', workspacePath: '/workspace', instanceDepth: 0, yoloMode: false, instanceId: 'test',
};

function check(cmd: string) {
  return validator.validate(cmd, parser.parse(cmd), ctx);
}

describe('PathValidator', () => {
  describe('blocked patterns', () => {
    it.each([
      'ln -s / /workspace/root',
      'ln -s /etc /workspace/config',
      'mount --bind / /mnt',
    ])('blocks symlink/mount attacks: "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });

    it.each([
      'echo "malicious" >> ~/.bashrc',
      'echo "malicious" >> ~/.zshrc',
      'echo "malicious" >> ~/.profile',
      'echo "malicious" >> ~/.bash_profile',
      'echo "key" >> ~/.ssh/authorized_keys',
    ])('blocks RC file/SSH key writes: "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('warn patterns', () => {
    it.each([
      'cat ~/.ssh/id_rsa',
      'ls ~/.gnupg/',
      'cat ~/.aws/credentials',
    ])('warns on sensitive dir access: "%s"', (cmd) => {
      expect(check(cmd).action).toBe('warn');
    });

    it('warns on /proc/self/environ access', () => {
      expect(check('cat /proc/self/environ').action).toBe('warn');
    });

    it('warns on tar extraction', () => {
      expect(check('tar -xf archive.tar.gz').action).toBe('warn');
    });

    it('warns on /tmp writes', () => {
      expect(check('echo data > /tmp/staging').action).toBe('warn');
    });

    it('warns on redirect to system directories', () => {
      expect(check('echo data > /etc/config').action).toBe('warn');
      expect(check('echo data > /usr/local/bin/evil').action).toBe('warn');
    });
  });

  describe('safe commands', () => {
    it.each([
      'ls -la', 'cat file.txt', 'cd /home/user',
      'cp file1 file2', 'ln -s a b',
    ])('allows "%s"', (cmd) => {
      expect(check(cmd).action).toBe('allow');
    });
  });
});
