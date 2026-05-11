import { describe, expect, it, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { LogManager } from '../logger';

describe('LogManager', () => {
  it('truncates oversized strings and summarizes deep objects', () => {
    const manager = new LogManager({
      enableConsole: false,
      enableFile: false,
    });

    manager.log('info', 'LoggerTest', 'x'.repeat(3000), {
      payload: 'y'.repeat(6000),
      nested: {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'too deep',
              },
            },
          },
        },
      },
      items: Array.from({ length: 30 }, (_unused, index) => index),
      buffer: Buffer.from('abc'),
    });

    const [entry] = manager.getRecentLogs({ limit: 1 });
    expect(entry.message).toContain('[truncated');
    expect(entry.data?.['payload']).toContain('[truncated');
    expect(entry.data?.['nested']).toEqual({
      level1: {
        level2: {
          level3: '[Object]',
        },
      },
    });
    expect(entry.data?.['items']).toHaveLength(26);
    expect(entry.data?.['items']).toContain('[+5 more items]');
    expect(entry.data?.['buffer']).toEqual({
      type: 'Buffer',
      length: 3,
    });
  });

  it('handles circular references without throwing', () => {
    const manager = new LogManager({
      enableConsole: false,
      enableFile: false,
    });

    const payload: Record<string, unknown> = { name: 'root' };
    payload['self'] = payload;

    manager.log('info', 'LoggerTest', 'circular payload', { payload });

    const [entry] = manager.getRecentLogs({ limit: 1 });
    expect(entry.data?.['payload']).toEqual({
      name: 'root',
      self: '[Circular]',
    });
  });

  describe('file size initialization', () => {
    let logDir: string;

    afterEach(() => {
      if (logDir) {
        fs.rmSync(logDir, { recursive: true, force: true });
      }
    });

    it('does not rotate a file just below the size limit', () => {
      logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtest-'));
      const logsDir = path.join(logDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, 'app.log');
      const maxFileSize = 2048;

      // Write exactly 1000 bytes — under the limit
      fs.writeFileSync(logFile, 'x'.repeat(1000));

      new LogManager({
        enableConsole: false,
        enableFile: true,
        logDirectory: logDir,
        maxFileSize,
        maxFiles: 5,
      });

      // File should still exist (not rotated)
      expect(fs.existsSync(logFile)).toBe(true);
      expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    });

    it('rotates an oversized log file on startup', () => {
      logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtest-'));
      const logsDir = path.join(logDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, 'app.log');

      // Write content larger than maxFileSize (1 KB limit for test)
      const maxFileSize = 1024;
      fs.writeFileSync(logFile, 'x'.repeat(maxFileSize + 100));

      new LogManager({
        enableConsole: false,
        enableFile: true,
        logDirectory: logDir,
        maxFileSize,
        maxFiles: 5,
      });

      // app.log should have been rotated to app.log.1
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      // Original app.log should no longer exist (rotated away)
      expect(fs.existsSync(logFile)).toBe(false);
    });

    it('leaves small log intact on startup', () => {
      logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtest-'));
      const logsDir = path.join(logDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, 'app.log');

      // 100 bytes well under the 1 MB limit
      fs.writeFileSync(logFile, 'x'.repeat(100));

      new LogManager({
        enableConsole: false,
        enableFile: true,
        logDirectory: logDir,
        maxFileSize: 1024 * 1024,
        maxFiles: 5,
      });

      // File should still exist
      expect(fs.existsSync(logFile)).toBe(true);
      expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    });

    it('logs remain in memory buffer when file writing is disabled', () => {
      const manager = new LogManager({
        enableConsole: false,
        enableFile: false,
      });

      manager.log('info', 'Test', 'hello world');
      const entries = manager.getRecentLogs({ limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('hello world');
    });
  });
});
