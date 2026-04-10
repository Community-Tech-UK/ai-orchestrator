import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Expose the in-memory db instance so we can close it between tests
let _testDb: InstanceType<typeof Database> | undefined;

vi.mock('../../../main/persistence/rlm-database', async () => {
  const BetterSQLite3 = (await import('better-sqlite3')).default;
  const schema = await import('../../../main/persistence/rlm/rlm-schema');
  return {
    getRLMDatabase: () => ({
      getRawDb: () => {
        if (!_testDb || !_testDb.open) {
          _testDb = new BetterSQLite3(':memory:');
          _testDb.pragma('foreign_keys = ON');
          schema.createTables(_testDb);
          schema.createMigrationsTable(_testDb);
          schema.runMigrations(_testDb);
        }
        return _testDb;
      },
    }),
  };
});

vi.mock('../../../main/logging/logger', () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { ConversationMiner, getConversationMiner } from '../../../main/memory/conversation-miner';

describe('ConversationMiner', () => {
  beforeEach(() => {
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
    ConversationMiner._resetForTesting();
  });

  // ── detectFormat ─────────────────────────────────────────────────────────

  describe('detectFormat (static)', () => {
    it('detects plain-text when there are >= 3 ">" markers', () => {
      const content = '> Hello\nResponse one\n> World\nResponse two\n> Again\nResponse three';
      expect(ConversationMiner.detectFormat(content)).toBe('plain-text');
    });

    it('detects claude-code-jsonl (type: human/assistant + message.content)', () => {
      const line = JSON.stringify({ type: 'human', message: { content: 'Hello there' } });
      expect(ConversationMiner.detectFormat(line)).toBe('claude-code-jsonl');
    });

    it('detects codex-jsonl (type: session_meta)', () => {
      const line = JSON.stringify({ type: 'session_meta', payload: { sessionId: 'abc' } });
      expect(ConversationMiner.detectFormat(line)).toBe('codex-jsonl');
    });

    it('detects codex-jsonl (type: event_msg)', () => {
      const line = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } });
      expect(ConversationMiner.detectFormat(line)).toBe('codex-jsonl');
    });

    it('detects chatgpt-json when array element has "mapping"', () => {
      const content = JSON.stringify([{ mapping: { root: { parent: null, children: [], message: null } }, title: 'My Chat' }]);
      expect(ConversationMiner.detectFormat(content)).toBe('chatgpt-json');
    });

    it('detects claude-ai-json when array element has "role"', () => {
      const content = JSON.stringify([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }]);
      expect(ConversationMiner.detectFormat(content)).toBe('claude-ai-json');
    });
  });

  // ── normalizeToMessages ───────────────────────────────────────────────────

  describe('normalizeToMessages (static)', () => {
    it('normalizes plain text to messages', () => {
      const content = '> What is TypeScript?\nTypeScript is a typed superset of JavaScript.\n> How do I install it?\nRun: npm install -g typescript';
      const messages = ConversationMiner.normalizeToMessages(content, 'plain-text');
      expect(messages.length).toBe(4);
      expect(messages[0]).toEqual({ role: 'user', content: 'What is TypeScript?' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' });
      expect(messages[2]).toEqual({ role: 'user', content: 'How do I install it?' });
      expect(messages[3]).toEqual({ role: 'assistant', content: 'Run: npm install -g typescript' });
    });

    it('normalizes Claude Code JSONL to messages', () => {
      const lines = [
        JSON.stringify({ type: 'human', message: { content: 'What is 2 + 2?' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'It is 4.' } }),
      ].join('\n');
      const messages = ConversationMiner.normalizeToMessages(lines, 'claude-code-jsonl');
      expect(messages.length).toBe(2);
      expect(messages[0]).toEqual({ role: 'user', content: 'What is 2 + 2?' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'It is 4.' });
    });
  });

  // ── chunkExchanges ────────────────────────────────────────────────────────

  describe('chunkExchanges (static)', () => {
    it('chunks Q+A pairs from text with > markers', () => {
      const transcript = [
        '> What is a function?',
        'A function is a reusable block of code that performs a specific task.',
        '> How do I define one?',
        'Use the function keyword followed by a name and parentheses.',
        '> Can functions return values?',
        'Yes, use the return statement to return a value from a function.',
      ].join('\n');

      const chunks = ConversationMiner.chunkExchanges(transcript, { minChunkSize: 10 });
      expect(chunks.length).toBeGreaterThan(0);
      // Each chunk should start with a user turn (>)
      for (const chunk of chunks) {
        expect(chunk.content).toMatch(/^>/);
      }
    });

    it('falls back to paragraph chunking when few > markers', () => {
      const transcript = 'This is a long paragraph without any markers.\n\nThis is another paragraph with some content.\n\nAnd a third one.';
      const chunks = ConversationMiner.chunkExchanges(transcript, { minChunkSize: 10, chunkSize: 100 });
      expect(chunks.length).toBeGreaterThan(0);
      // Paragraph chunks won't necessarily start with >
      expect(chunks[0].content.length).toBeGreaterThanOrEqual(10);
    });
  });

  // ── detectRoom ────────────────────────────────────────────────────────────

  describe('detectRoom (static)', () => {
    it('detects "technical" from code/bug/api keywords', () => {
      const text = 'I have a bug in my code. The API is returning an error. Let me debug this function.';
      expect(ConversationMiner.detectRoom(text)).toBe('technical');
    });

    it('detects "architecture" from design/pattern keywords', () => {
      const text = 'We need to discuss the architecture and design patterns. The module structure and component interfaces need review.';
      expect(ConversationMiner.detectRoom(text)).toBe('architecture');
    });

    it('falls back to "general" when no strong topic keywords', () => {
      const text = 'Hello, how are you today? The weather is nice.';
      expect(ConversationMiner.detectRoom(text)).toBe('general');
    });
  });

  // ── importFromString ──────────────────────────────────────────────────────

  describe('importFromString (instance method)', () => {
    it('mines a plain text conversation into segments, verify segmentsCreated > 0', () => {
      const miner = ConversationMiner.getInstance();
      const content = [
        '> What is dependency injection?',
        'Dependency injection is a design pattern where dependencies are passed to a component rather than created inside it.',
        '> Why is it useful?',
        'It makes code more testable, modular, and maintainable by reducing coupling between components.',
        '> Can you give an example?',
        'Instead of creating a database connection inside a service, you pass the connection as a constructor argument.',
      ].join('\n');

      const result = miner.importFromString(content, {
        wing: 'test-wing',
        sourceFile: '/test/convo.txt',
      });

      expect(result.segmentsCreated).toBeGreaterThan(0);
      expect(result.filesProcessed).toBe(1);
      expect(result.formatDetected).toBe('plain-text');
      expect(result.errors).toHaveLength(0);
    });

    it('returns error for content with fewer than 2 messages', () => {
      const miner = ConversationMiner.getInstance();
      const result = miner.importFromString('just some plain text with no markers', {
        wing: 'test-wing',
        sourceFile: '/test/short.txt',
      });
      expect(result.segmentsCreated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('does not duplicate import for same source file', () => {
      const miner = ConversationMiner.getInstance();
      const content = [
        '> Question one?',
        'Answer one with enough text to form a chunk.',
        '> Question two?',
        'Answer two with more text here.',
        '> Question three?',
        'Answer three to ensure we have enough messages.',
      ].join('\n');

      const result1 = miner.importFromString(content, {
        wing: 'test-wing',
        sourceFile: '/test/duplicate.txt',
      });
      expect(result1.segmentsCreated).toBeGreaterThan(0);

      const result2 = miner.importFromString(content, {
        wing: 'test-wing',
        sourceFile: '/test/duplicate.txt',
      });
      expect(result2.segmentsCreated).toBe(0);
      expect(result2.errors.some(e => e.includes('already imported'))).toBe(true);
    });

    it('emits miner:import-complete event', () => {
      const miner = ConversationMiner.getInstance();
      const events: unknown[] = [];
      miner.on('miner:import-complete', (payload) => events.push(payload));

      const content = [
        '> What is TypeScript?',
        'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
        '> Is it popular?',
        'Yes, it is widely used in large codebases and supported by many frameworks.',
        '> How do I start?',
        'Install it with npm install -g typescript and use tsc to compile.',
      ].join('\n');

      miner.importFromString(content, {
        wing: 'test-wing',
        sourceFile: '/test/emit-test.txt',
      });

      expect(events).toHaveLength(1);
      const event = events[0] as { sourceFile: string; segmentsCreated: number; format: string };
      expect(event.sourceFile).toBe('/test/emit-test.txt');
      expect(event.segmentsCreated).toBeGreaterThan(0);
      expect(event.format).toBe('plain-text');
    });
  });

  // ── Singleton pattern ─────────────────────────────────────────────────────

  describe('singleton pattern', () => {
    it('getInstance returns the same instance each time', () => {
      const a = ConversationMiner.getInstance();
      const b = ConversationMiner.getInstance();
      expect(a).toBe(b);
    });

    it('getConversationMiner convenience getter returns the singleton', () => {
      const miner = getConversationMiner();
      expect(miner).toBe(ConversationMiner.getInstance());
    });

    it('_resetForTesting creates a new instance after reset', () => {
      const before = ConversationMiner.getInstance();
      ConversationMiner._resetForTesting();
      const after = ConversationMiner.getInstance();
      expect(before).not.toBe(after);
    });
  });
});
