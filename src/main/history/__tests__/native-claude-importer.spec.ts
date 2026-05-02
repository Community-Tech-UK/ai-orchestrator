import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findClaudeJsonlFiles,
  parseClaudeJsonlTranscript,
} from '../native-claude-importer';

describe('native-claude-importer', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-claude-importer-'));
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeJsonl(filePath: string, lines: object[]): void {
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  describe('parseClaudeJsonlTranscript', () => {
    it('extracts session metadata, messages, and previews from a simple transcript', async () => {
      const filePath = path.join(tmpDir, 'session-a.jsonl');
      writeJsonl(filePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-04-10T09:00:00.000Z',
          cwd: '/Users/me/work/Demo',
          sessionId: 'sess-a',
          message: { role: 'user', content: 'Hello world' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-04-10T09:00:05.000Z',
          cwd: '/Users/me/work/Demo',
          sessionId: 'sess-a',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'pondering...' },
              { type: 'text', text: 'Hi there.' },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-04-10T09:01:00.000Z',
          cwd: '/Users/me/work/Demo',
          sessionId: 'sess-a',
          message: { role: 'user', content: 'Goodbye' },
        },
      ]);

      const result = await parseClaudeJsonlTranscript(filePath);

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-a');
      expect(result!.workingDirectory).toBe('/Users/me/work/Demo');
      expect(result!.firstUserMessage).toBe('Hello world');
      expect(result!.lastUserMessage).toBe('Goodbye');
      expect(result!.messages).toHaveLength(3);
      expect(result!.messages[0].type).toBe('user');
      expect(result!.messages[1].type).toBe('assistant');
      expect(result!.messages[1].content).toContain('Hi there.');
      expect(result!.messages[1].content).toContain('pondering...');
      expect(result!.createdAt).toBe(Date.parse('2026-04-10T09:00:00.000Z'));
      expect(result!.endedAt).toBe(Date.parse('2026-04-10T09:01:00.000Z'));
    });

    it('returns null for transcripts with no user messages', async () => {
      const filePath = path.join(tmpDir, 'empty.jsonl');
      writeJsonl(filePath, [
        { type: 'system', sessionId: 'sess-empty', timestamp: '2026-04-10T09:00:00.000Z' },
      ]);

      const result = await parseClaudeJsonlTranscript(filePath);
      expect(result).toBeNull();
    });

    it('skips sidechain messages', async () => {
      const filePath = path.join(tmpDir, 'sidechain.jsonl');
      writeJsonl(filePath, [
        {
          type: 'user',
          uuid: 'u1',
          isSidechain: false,
          timestamp: '2026-04-10T09:00:00.000Z',
          cwd: '/p',
          sessionId: 's1',
          message: { role: 'user', content: 'main user msg' },
        },
        {
          type: 'user',
          uuid: 'u2',
          isSidechain: true,
          timestamp: '2026-04-10T09:00:30.000Z',
          cwd: '/p',
          sessionId: 's1',
          message: { role: 'user', content: 'sub-agent msg' },
        },
      ]);

      const result = await parseClaudeJsonlTranscript(filePath);
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(1);
      expect(result!.messages[0].content).toBe('main user msg');
    });

    it('handles tool_result content blocks in user messages', async () => {
      const filePath = path.join(tmpDir, 'tool-result.jsonl');
      writeJsonl(filePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-04-10T09:00:00.000Z',
          cwd: '/p',
          sessionId: 's1',
          message: { role: 'user', content: 'kick off' },
        },
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-04-10T09:00:30.000Z',
          cwd: '/p',
          sessionId: 's1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'output of grep',
              },
            ],
          },
        },
      ]);

      const result = await parseClaudeJsonlTranscript(filePath);
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[1].content).toBe('output of grep');
    });

    it('skips malformed JSON lines without failing the whole file', async () => {
      const filePath = path.join(tmpDir, 'bad-line.jsonl');
      fs.writeFileSync(
        filePath,
        [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-04-10T09:00:00.000Z',
            cwd: '/p',
            sessionId: 's1',
            message: { role: 'user', content: 'good' },
          }),
          '{ this is not json',
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: '2026-04-10T09:00:05.000Z',
            cwd: '/p',
            sessionId: 's1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
          }),
        ].join('\n')
      );

      const result = await parseClaudeJsonlTranscript(filePath);
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].content).toBe('good');
      expect(result!.messages[1].content).toBe('reply');
    });
  });

  describe('findClaudeJsonlFiles', () => {
    it('returns empty when projects dir does not exist', async () => {
      const files = await findClaudeJsonlFiles(path.join(tmpDir, 'does-not-exist'));
      expect(files).toEqual([]);
    });

    it('finds .jsonl files across subdirectories', async () => {
      const projectsDir = path.join(tmpDir, 'projects');
      const projectA = path.join(projectsDir, '-Users-me-A');
      const projectB = path.join(projectsDir, '-Users-me-B');
      fs.mkdirSync(projectA, { recursive: true });
      fs.mkdirSync(projectB, { recursive: true });
      fs.writeFileSync(path.join(projectA, 'sess-1.jsonl'), '');
      fs.writeFileSync(path.join(projectA, 'notes.txt'), '');
      fs.writeFileSync(path.join(projectB, 'sess-2.jsonl'), '');

      const files = await findClaudeJsonlFiles(projectsDir);
      expect(files.sort()).toEqual([
        path.join(projectA, 'sess-1.jsonl'),
        path.join(projectB, 'sess-2.jsonl'),
      ].sort());
    });
  });
});
