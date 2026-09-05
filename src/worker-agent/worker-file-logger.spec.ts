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

describe('WorkerFileLogger stream capture', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('captures direct process.stderr writes that bypass console', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logger = new WorkerFileLogger({ logDir: dir, mirrorToConsole: false }).install();
    try {
      process.stderr.write('(node:123) [DEP0190] DeprecationWarning: bypassed console\n');
    } finally {
      logger.uninstall();
    }

    const contents = fs.readFileSync(path.join(dir, 'worker-agent.log'), 'utf-8');
    expect(contents).toContain('[STDERR] (node:123) [DEP0190] DeprecationWarning: bypassed console');
  });

  it('captures Buffer chunks and splits multi-line writes', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logger = new WorkerFileLogger({ logDir: dir, mirrorToConsole: false }).install();
    try {
      process.stderr.write(Buffer.from('first line\nsecond line\n', 'utf-8'));
    } finally {
      logger.uninstall();
    }

    const contents = fs.readFileSync(path.join(dir, 'worker-agent.log'), 'utf-8');
    expect(contents).toContain('[STDERR] first line');
    expect(contents).toContain('[STDERR] second line');
    // Blank segments from the trailing newline must not become empty log lines.
    expect(contents).not.toMatch(/\[STDERR\] *\n/);
  });

  it('does not double-record a console line that is mirrored to the stream', () => {
    const dir = tmpDir();
    dirs.push(dir);
    // mirrorToConsole:true is the production default and is what makes
    // double-capture possible: console.error itself writes to process.stderr.
    const logger = new WorkerFileLogger({ logDir: dir, mirrorToConsole: true }).install();
    try {
      console.error('only-once-marker');
    } finally {
      logger.uninstall();
    }

    const contents = fs.readFileSync(path.join(dir, 'worker-agent.log'), 'utf-8');
    const occurrences = contents.split('only-once-marker').length - 1;
    expect(occurrences).toBe(1);
    expect(contents).toContain('[ERROR] only-once-marker');
  });

  it('restores the original stream writes on uninstall', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const beforeOut = process.stdout.write;
    const beforeErr = process.stderr.write;

    const logger = new WorkerFileLogger({ logDir: dir, mirrorToConsole: false }).install();
    try {
      // A failure here must not leave the real globals patched for the rest of
      // the vitest worker while afterEach deletes the temp dir underneath them.
      expect(process.stderr.write).not.toBe(beforeErr);
    } finally {
      logger.uninstall();
    }

    expect(process.stdout.write).toBe(beforeOut);
    expect(process.stderr.write).toBe(beforeErr);
  });
});
