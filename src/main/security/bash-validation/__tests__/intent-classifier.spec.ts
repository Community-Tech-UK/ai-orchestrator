import { describe, it, expect } from 'vitest';
import { IntentClassifier } from '../intent-classifier';
import { CommandParser } from '../command-parser';

const classifier = new IntentClassifier();
const parser = new CommandParser();

function classify(cmd: string) {
  return classifier.classify(parser.parse(cmd).segments);
}

describe('IntentClassifier', () => {
  it.each([
    ['ls -la', 'read_only'],
    ['cat file.txt', 'read_only'],
    ['grep pattern file', 'read_only'],
    ['pwd', 'read_only'],
    ['whoami', 'read_only'],
  ] as const)('classifies "%s" as %s', (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });

  it.each([
    ['cp src dest', 'write'],
    ['mv old new', 'write'],
    ['mkdir dir', 'write'],
    ['touch file', 'write'],
    ['chmod 755 file', 'write'],
  ] as const)('classifies "%s" as %s', (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });

  it.each([
    ['rm -rf dir', 'destructive'],
    ['shred file', 'destructive'],
    ['mkfs /dev/sda', 'destructive'],
    ['shutdown now', 'destructive'],
  ] as const)('classifies "%s" as %s', (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });

  it.each([
    ['curl http://example.com', 'network'],
    ['wget http://example.com', 'network'],
    ['ssh user@host', 'network'],
    ['nmap localhost', 'network'],
  ] as const)('classifies "%s" as %s', (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });

  it.each([
    ['npm install lodash', 'package_management'],
    ['pip install requests', 'package_management'],
    ['brew install jq', 'package_management'],
  ] as const)('classifies "%s" as %s', (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });

  it.each([
    ['kill -9 1234', 'process_management'],
    ['systemctl restart nginx', 'process_management'],
  ] as const)('classifies "%s" as %s', (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });

  it.each([
    ['useradd bob', 'system_admin'],
    ['passwd root', 'system_admin'],
    ['mount /dev/sda1 /mnt', 'system_admin'],
  ] as const)('classifies "%s" as %s', (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });

  it('classifies unknown commands as unknown', () => {
    expect(classify('myCustomTool --flag')).toBe('unknown');
  });

  it('uses most severe intent for compound commands', () => {
    expect(classify('ls -la && rm -rf dir')).toBe('destructive');
    expect(classify('echo hi ; curl http://example.com')).toBe('network');
  });
});
