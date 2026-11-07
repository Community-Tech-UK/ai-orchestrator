import { describe, expect, it } from 'vitest';
import { runProbeCommand } from './probe-command';

describe('runProbeCommand', () => {
  const node = process.execPath;

  it('returns output and exit code 0 on success', async () => {
    const result = await runProbeCommand(node, ['-e', 'process.stdout.write("hi")'], 10_000);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hi', timedOut: false, notFound: false });
  });

  it('classifies a non-zero exit as ran-and-failed, keeping its output', async () => {
    const result = await runProbeCommand(node, ['-e', 'process.stdout.write("no");process.exit(3)'], 10_000);
    expect(result).toMatchObject({ exitCode: 3, stdout: 'no', timedOut: false, notFound: false });
  });

  it('classifies a missing program as not found, not as a failed command', async () => {
    const result = await runProbeCommand('/nonexistent/aio-probe-tool', [], 10_000);
    expect(result).toMatchObject({ exitCode: null, timedOut: false, notFound: true });
  });

  it('classifies a command that outlives its limit as timed out', async () => {
    const result = await runProbeCommand(node, ['-e', 'setTimeout(() => {}, 30000)'], 200);
    expect(result).toMatchObject({ exitCode: null, timedOut: true, notFound: false });
  });
});
