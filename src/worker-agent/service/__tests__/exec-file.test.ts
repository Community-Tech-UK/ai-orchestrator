import { describe, it, expect } from 'vitest';
import { execFileCapture, ExecFileError } from '../exec-file';

describe('execFileCapture', () => {
  it('returns stdout on success', async () => {
    const result = await execFileCapture('node', ['-e', 'process.stdout.write("hi")']);
    expect(result.stdout).toBe('hi');
    expect(result.exitCode).toBe(0);
  });

  it('throws ExecFileError with stderr on non-zero exit', async () => {
    try {
      await execFileCapture('node', ['-e', 'process.stderr.write("boom"); process.exit(3)']);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecFileError);
      expect(err).toMatchObject({
        exitCode: 3,
        stderr: expect.stringContaining('boom'),
      });
    }
  });

  it('never evaluates shell metacharacters in arguments', async () => {
    // If a shell were involved, $(echo x) would expand. With execFile it stays literal.
    const result = await execFileCapture('node', ['-e', 'process.stdout.write(process.argv[1])', '$(echo x)']);
    expect(result.stdout).toBe('$(echo x)');
  });
});
