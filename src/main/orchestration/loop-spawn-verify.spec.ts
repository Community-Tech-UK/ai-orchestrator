import { describe, expect, it } from 'vitest';
import { spawnVerifyCommand } from './loop-spawn-verify';

const runNode = (script: string) => spawnVerifyCommand(script, process.cwd(), 5_000, 'verify', false, {
  buildInvocation: code => ({ file: process.execPath, args: ['-e', code], useShellOption: false }),
  classifyFailure: () => 'command',
});

describe('spawnVerifyCommand output capture', () => {
  it.each(['stdout', 'stderr'] as const)('reports truncation when a real child fills %s beyond the cap', async stream => {
    const result = await runNode(`process.${stream}.write('x'.repeat(200001), () => process.exit(1))`);
    expect(result.status).toBe('failed'); expect(result.outputTruncated).toBe(true);
    expect(result.output.match(/x/g)).toHaveLength(200_000);
  });
  it('does not mark complete output as truncated at the exact cap', async () => {
    const result = await runNode("process.stdout.write('x'.repeat(200000), () => process.exit(1))");
    expect(result.outputTruncated).not.toBe(true); expect(result.output.length).toBe(200_000);
  });
  it('marks truncation for a passing command too', async () => {
    const result = await runNode("process.stdout.write('x'.repeat(200001))");
    expect(result.status).toBe('passed'); expect(result.outputTruncated).toBe(true);
  });
});
