import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveToken, TokenSource } from '../token-resolver';

describe('resolveToken', () => {
  const origEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-'));
  });

  afterEach(async () => {
    process.env = { ...origEnv };
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads token from file and trims trailing newline', async () => {
    const file = path.join(tempDir, 'tok');
    await fs.writeFile(file, 'abc123\n', { mode: 0o600 });
    const { token, source } = await resolveToken({ tokenFile: file });
    expect(token).toBe('abc123');
    expect(source).toBe(TokenSource.File);
  });

  it('reads from env when tokenEnv set', async () => {
    process.env.TESTING_TOKEN = 'envvalue';
    const { token, source } = await resolveToken({ tokenEnv: 'TESTING_TOKEN' });
    expect(token).toBe('envvalue');
    expect(source).toBe(TokenSource.Env);
  });

  it('rejects empty token', async () => {
    const file = path.join(tempDir, 'tok');
    await fs.writeFile(file, '\n', { mode: 0o600 });
    await expect(resolveToken({ tokenFile: file })).rejects.toThrow(/empty/i);
  });
});
