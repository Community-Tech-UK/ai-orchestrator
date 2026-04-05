// src/main/security/bash-validation/__tests__/command-parser.spec.ts
import { describe, it, expect } from 'vitest';
import { CommandParser } from '../command-parser';

const parser = new CommandParser();

describe('CommandParser', () => {
  describe('simple commands', () => {
    it('parses a single command', () => {
      const result = parser.parse('ls -la');
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].mainCommand).toBe('ls');
      expect(result.segments[0].arguments).toEqual(['-la']);
    });

    it('returns empty segments for empty input', () => {
      expect(parser.parse('').segments).toHaveLength(0);
      expect(parser.parse('  ').segments).toHaveLength(0);
    });

    it('strips path prefix from commands', () => {
      const result = parser.parse('/usr/bin/cat file.txt');
      expect(result.segments[0].mainCommand).toBe('cat');
    });
  });

  describe('compound commands', () => {
    it('splits on semicolons', () => {
      const result = parser.parse('echo a ; echo b');
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].mainCommand).toBe('echo');
      expect(result.segments[1].mainCommand).toBe('echo');
    });

    it('splits on && operator', () => {
      const result = parser.parse('mkdir dir && cd dir');
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].mainCommand).toBe('mkdir');
      expect(result.segments[1].mainCommand).toBe('cd');
    });

    it('splits on || operator', () => {
      const result = parser.parse('test -f x || echo missing');
      expect(result.segments).toHaveLength(2);
    });

    it('does not split inside quotes', () => {
      const result = parser.parse('echo "a && b"');
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].mainCommand).toBe('echo');
    });

    it('detects backgrounded commands', () => {
      const result = parser.parse('sleep 10 & echo done');
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].backgrounded).toBe(true);
      expect(result.segments[1].backgrounded).toBe(false);
    });
  });

  describe('pipe handling', () => {
    it('extracts pipe targets', () => {
      const result = parser.parse('cat file | grep pattern | head');
      expect(result.segments[0].mainCommand).toBe('cat');
      expect(result.segments[0].pipes).toEqual(['grep pattern', 'head']);
    });

    it('does not split on ||', () => {
      const result = parser.parse('cat file || echo fail');
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].pipes).toEqual([]);
    });
  });

  describe('redirect handling', () => {
    it('extracts output redirects', () => {
      const result = parser.parse('echo hello > output.txt');
      expect(result.segments[0].redirects).toEqual(['> output.txt']);
      expect(result.segments[0].mainCommand).toBe('echo');
    });

    it('extracts append redirects', () => {
      const result = parser.parse('echo hello >> output.txt');
      expect(result.segments[0].redirects).toEqual(['>> output.txt']);
    });
  });

  describe('sudo/privilege stripping', () => {
    it('strips sudo prefix', () => {
      const result = parser.parse('sudo rm -rf /tmp/junk');
      expect(result.segments[0].mainCommand).toBe('rm');
    });

    it('strips sudo -u root prefix', () => {
      const result = parser.parse('sudo -u root cat /etc/shadow');
      expect(result.segments[0].mainCommand).toBe('cat');
    });

    it('strips doas prefix', () => {
      const result = parser.parse('doas apt update');
      expect(result.segments[0].mainCommand).toBe('apt');
    });

    it('strips pkexec prefix', () => {
      const result = parser.parse('pkexec visudo');
      expect(result.segments[0].mainCommand).toBe('visudo');
    });
  });

  describe('wrapper stripping', () => {
    it('strips env prefix', () => {
      const result = parser.parse('env VAR=val cat file');
      expect(result.segments[0].mainCommand).toBe('cat');
    });

    it('strips time prefix', () => {
      const result = parser.parse('time ls -la');
      expect(result.segments[0].mainCommand).toBe('ls');
    });

    it('strips timeout with argument', () => {
      const result = parser.parse('timeout 30 curl http://example.com');
      expect(result.segments[0].mainCommand).toBe('curl');
    });
  });

  describe('preserves raw segment', () => {
    it('keeps rawSegment intact', () => {
      const result = parser.parse('sudo rm -rf /tmp');
      expect(result.segments[0].rawSegment).toBe('sudo rm -rf /tmp');
    });

    it('keeps raw on ParsedCommand', () => {
      const result = parser.parse('ls -la');
      expect(result.raw).toBe('ls -la');
    });
  });
});
