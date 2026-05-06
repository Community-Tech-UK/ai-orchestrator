import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpSecretStorage } from '../secret-storage';
import { SecretClassifier } from '../secret-classifier';
import { RedactionService } from '../redaction-service';
import { WriteSafetyHelper } from '../write-safety-helper';
import { REDACTED_SENTINEL } from '../../../shared/types/mcp-dtos.types';

describe('MCP core services', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-mcp-core-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('encrypts with safeStorage when available and falls back explicitly', () => {
    const encrypted = new McpSecretStorage({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(`enc:${plain}`),
        decryptString: (payload) => payload.toString('utf8').replace(/^enc:/, ''),
      },
    });
    const secret = encrypted.encryptSecret('hunter2');
    expect(secret.status).toBe('encrypted');
    expect(secret.payload).not.toContain('hunter2');
    expect(encrypted.decryptSecret(secret)).toBe('hunter2');

    const fallback = new McpSecretStorage({
      safeStorage: { isEncryptionAvailable: () => false },
    });
    expect(() => fallback.encryptSecret('hunter2')).toThrow('SAFESTORAGE_UNAVAILABLE');
  });

  it('classifies and redacts likely secrets', () => {
    const classifier = new SecretClassifier();
    expect(classifier.isSecret('GITHUB_TOKEN', 'x')).toBe(true);
    expect(classifier.isSecret('HOME', '/Users/suas')).toBe(false);

    const redaction = new RedactionService(classifier);
    const dto = redaction.redact(
      {
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'node',
        env: { HOME: '/Users/suas', API_KEY: 'abc' },
        autoConnect: true,
        createdAt: 1,
        updatedAt: 1,
      },
      { scope: 'user', readOnly: false },
    );
    expect(dto.env).toEqual({ HOME: '/Users/suas', API_KEY: REDACTED_SENTINEL });
  });

  it('redacts secret headers, URL credentials, and secret args', () => {
    const redaction = new RedactionService(new SecretClassifier());
    const dto = redaction.redact(
      {
        id: 'x',
        name: 'x',
        transport: 'http',
        url: 'https://user:pass@example.test/mcp?token=abc&mode=read',
        headers: { Authorization: 'Bearer abc', Accept: 'application/json' },
        args: ['--api-key', 'abc', '--mode=read'],
        autoConnect: true,
        createdAt: 1,
        updatedAt: 1,
      },
      { scope: 'user', readOnly: false },
    );

    expect(dto.url).not.toContain('pass');
    expect(dto.url).not.toContain('token=abc');
    expect(dto.headers).toEqual({
      Authorization: REDACTED_SENTINEL,
      Accept: 'application/json',
    });
    expect(dto.args).toEqual(['--api-key', REDACTED_SENTINEL, '--mode=read']);
  });

  it('writes atomically with single-generation backups, mode preservation, and cleanup', async () => {
    const helper = new WriteSafetyHelper({
      allowWorldWritableParent: false,
      writeBackups: true,
    });
    const target = path.join(tmp, 'config.json');
    await helper.writeAtomic(target, 'old');
    if (process.platform !== 'win32') {
      fs.chmodSync(target, 0o600);
    }
    await helper.writeAtomic(target, 'new');
    await helper.writeAtomic(target, 'newer');
    expect(fs.readFileSync(target, 'utf8')).toBe('newer');
    const backup = `${target}.orch-bak`;
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.readFileSync(backup, 'utf8')).toBe('old');
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    }
    await helper.cleanupBackups([target]);
    expect(fs.existsSync(backup)).toBe(false);
  });
});
