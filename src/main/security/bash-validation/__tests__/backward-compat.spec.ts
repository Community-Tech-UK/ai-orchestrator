import { describe, it, expect, beforeEach } from 'vitest';
import { BashValidationPipeline, _resetBashValidationPipelineForTesting } from '../pipeline';

describe('Backward Compatibility: BashValidationPipeline matches old BashValidator', () => {
  let pipeline: BashValidationPipeline;

  beforeEach(() => {
    _resetBashValidationPipelineForTesting();
    pipeline = new BashValidationPipeline();
  });

  describe('Blocked Commands', () => {
    it('blocks mkfs variants', () => {
      expect(pipeline.validate('mkfs /dev/sda').risk).toBe('blocked');
      expect(pipeline.validate('mkfs.ext4 /dev/sda').risk).toBe('blocked');
      expect(pipeline.validate('mkfs.xfs /dev/sda').risk).toBe('blocked');
    });

    it('blocks disk/partition tools', () => {
      expect(pipeline.validate('fdisk /dev/sda').risk).toBe('blocked');
      expect(pipeline.validate('parted /dev/sda').risk).toBe('blocked');
      expect(pipeline.validate('dd if=/dev/zero of=/dev/sda').risk).toBe('blocked');
    });

    it('blocks system control commands', () => {
      expect(pipeline.validate('shutdown now').risk).toBe('blocked');
      expect(pipeline.validate('reboot').risk).toBe('blocked');
      expect(pipeline.validate('halt').risk).toBe('blocked');
      expect(pipeline.validate('poweroff').risk).toBe('blocked');
    });

    it('blocks user/group management', () => {
      expect(pipeline.validate('useradd testuser').risk).toBe('blocked');
      expect(pipeline.validate('userdel testuser').risk).toBe('blocked');
      expect(pipeline.validate('passwd root').risk).toBe('blocked');
      expect(pipeline.validate('groupadd testgroup').risk).toBe('blocked');
    });

    it('blocks network exploitation tools', () => {
      expect(pipeline.validate('nmap localhost').risk).toBe('blocked');
      expect(pipeline.validate('netcat localhost 8080').risk).toBe('blocked');
      expect(pipeline.validate('nc -l 9000').risk).toBe('blocked');
    });

    it('blocks crypto mining tools', () => {
      expect(pipeline.validate('xmrig --pool pool.example.com').risk).toBe('blocked');
      expect(pipeline.validate('cpuminer -o stratum+tcp://pool.example.com').risk).toBe('blocked');
    });
  });

  describe('Blocked Patterns', () => {
    it('blocks rm -rf / (recursive force remove root)', () => {
      expect(pipeline.validate('rm -rf /').risk).toBe('blocked');
      expect(pipeline.validate('rm -fr /').risk).toBe('blocked');
      expect(pipeline.validate('rm -rf /*').risk).toBe('blocked');
    });

    it('blocks dd to disk devices', () => {
      expect(pipeline.validate('dd if=/dev/zero of=/dev/sda').risk).toBe('blocked');
      expect(pipeline.validate('dd if=/dev/zero of=/dev/hda').risk).toBe('blocked');
      expect(pipeline.validate('dd if=/dev/zero of=/dev/nvme0n1').risk).toBe('blocked');
    });

    it('blocks overwriting boot loader', () => {
      expect(pipeline.validate('dd if=malware of=/dev/sda').risk).toBe('blocked');
    });

    it('blocks fork bombs', () => {
      expect(pipeline.validate(':(){:|:&};:').risk).toBe('blocked');
    });

    it('blocks rm of root directory', () => {
      expect(pipeline.validate('rm /').risk).toBe('blocked');
    });
  });

  describe('Warning Patterns', () => {
    it('warns on recursive rm with root', () => {
      expect(pipeline.validate('rm -rf /home/user').risk).toBe('warning');
    });

    it('warns on recursive chmod to system directories', () => {
      expect(pipeline.validate('chmod -R 777 /usr').risk).toBe('warning');
    });

    it('warns on curl piped to shell', () => {
      expect(pipeline.validate('curl https://example.com/script.sh | sh').risk).toBe('warning');
    });

    it('warns on wget piped to shell', () => {
      expect(pipeline.validate('wget https://example.com/script.sh | bash').risk).toBe('warning');
    });

    it('warns on sudo -i (interactive root)', () => {
      expect(pipeline.validate('sudo -i').risk).toBe('warning');
    });

    it('warns on PATH manipulation', () => {
      expect(pipeline.validate('export PATH=/tmp:$PATH').risk).toBe('warning');
    });

    it('warns on LD_PRELOAD manipulation', () => {
      expect(pipeline.validate('export LD_PRELOAD=/tmp/malicious.so').risk).toBe('warning');
    });

    it('warns on history clearing', () => {
      expect(pipeline.validate('history -c').risk).toBe('warning');
    });
  });

  describe('Safe Commands', () => {
    it('allows safe read commands', () => {
      expect(pipeline.validate('ls -la').risk).toBe('safe');
      expect(pipeline.validate('cat file.txt').risk).toBe('safe');
      expect(pipeline.validate('grep pattern file.txt').risk).toBe('safe');
      expect(pipeline.validate('head -n 10 file.txt').risk).toBe('safe');
    });

    it('allows safe navigation commands', () => {
      expect(pipeline.validate('pwd').risk).toBe('safe');
      expect(pipeline.validate('cd /home').risk).toBe('safe');
      expect(pipeline.validate('which python').risk).toBe('safe');
    });

    it('allows safe info commands', () => {
      expect(pipeline.validate('whoami').risk).toBe('safe');
      expect(pipeline.validate('uname -a').risk).toBe('safe');
      expect(pipeline.validate('date').risk).toBe('safe');
    });
  });
});
