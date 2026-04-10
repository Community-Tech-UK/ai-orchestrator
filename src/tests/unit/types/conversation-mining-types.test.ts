import { describe, it, expect } from 'vitest';
import type {
  ConversationFormat,
  NormalizedMessage,
  ConversationSegment,
  MiningConfig,
  ConvoMemoryType,
  MiningResult,
  ImportSource,
} from '../../../shared/types/conversation-mining.types';

describe('conversation-mining types', () => {
  it('should enumerate all supported formats', () => {
    const formats: ConversationFormat[] = [
      'claude-code-jsonl',
      'codex-jsonl',
      'claude-ai-json',
      'chatgpt-json',
      'slack-json',
      'plain-text',
    ];
    expect(formats).toHaveLength(6);
  });

  it('should create normalized messages', () => {
    const msg: NormalizedMessage = {
      role: 'user',
      content: 'How do I handle errors?',
      timestamp: Date.now(),
    };
    expect(msg.role).toBe('user');
  });

  it('should create a conversation segment', () => {
    const segment: ConversationSegment = {
      id: 'seg_001',
      content: '> How do I handle errors?\nUse try-catch blocks...',
      chunkIndex: 0,
      memoryType: 'technical',
      sourceFile: '/path/to/convo.jsonl',
      wing: 'project_a',
      room: 'backend',
      importedAt: Date.now(),
    };
    expect(segment.memoryType).toBe('technical');
  });

  it('should create mining config', () => {
    const config: MiningConfig = {
      chunkSize: 800,
      chunkOverlap: 100,
      minChunkSize: 50,
      maxFileSize: 10 * 1024 * 1024,
      topicKeywords: {
        technical: ['code', 'function', 'bug', 'error'],
        architecture: ['design', 'pattern', 'schema'],
      },
    };
    expect(config.chunkSize).toBe(800);
  });

  it('should create mining result', () => {
    const result: MiningResult = {
      segmentsCreated: 42,
      filesProcessed: 3,
      formatDetected: 'claude-code-jsonl',
      errors: [],
      duration: 1500,
    };
    expect(result.segmentsCreated).toBe(42);
  });
});
