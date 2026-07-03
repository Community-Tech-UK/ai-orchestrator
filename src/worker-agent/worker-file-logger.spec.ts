import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerFileLogger } from './worker-file-logger';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-worker-log-'));
}

describe('WorkerFileLogger', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('tees console output to the log file and mirrors to console', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logger = new WorkerFileLogger({ logDir: dir, mirrorToConsole: false }).install();
    try {
      console.log('hello', { a: 1 });
      console.warn('a warning');
      console.error(new Error('boom'));
    } finally {
      logger.uninstall();
    }

    const contents = fs.readFileSync(path.join(dir, 'worker-agent.log'), 'utf-8');
    expect(contents).toContain('[LOG] hello');
    expect(contents).toContain("{ a: 1 }");
    expect(contents).toContain('[WARN] a warning');
    expect(contents).toContain('[ERROR]');
    expect(contents).toContain('boom');
  });

  it('rotates the log file once it exceeds the size cap', () => {
    const dir = tmpDir();
    dirs.push(dir);
    // 1 KB cap so a few lines trigger rotation.
    const logger = new WorkerFileLogger({
      logDir: dir,
      maxBytes: 1024,
      maxFiles: 2,
      mirrorToConsole: false,
    }).install();
    try {
      for (let i = 0; i < 50; i++) {
        console.log('line-'.repeat(20) + i);
      }
    } finally {
      logger.uninstall();
    }

    const base = path.join(dir, 'worker-agent.log');
    expect(fs.existsSync(base)).toBe(true);
    expect(fs.existsSync(`${base}.1`)).toBe(true);
    // maxFiles=2 → never keep a .3
    expect(fs.existsSync(`${base}.3`)).toBe(false);
    // Active file stays under the cap after rotation.
    expect(fs.statSync(base).size).toBeLessThanOrEqual(1024 + 512);
  });

  it('write() emits an explicit structured lifecycle line', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logger = new WorkerFileLogger({ logDir: dir, mirrorToConsole: false });
    logger.write('info', 'registration accepted', { nodeId: 'n1' });

    const contents = fs.readFileSync(path.join(dir, 'worker-agent.log'), 'utf-8');
    expect(contents).toContain('[INFO] registration accepted {"nodeId":"n1"}');
  });
});
