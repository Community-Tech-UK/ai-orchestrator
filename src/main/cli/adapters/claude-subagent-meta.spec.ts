import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSubagentTranscriptPath,
  readClaudeSubagentMeta,
  readClaudeSubagentTranscriptModel,
  sumClaudeSubagentTranscriptUsage,
  type ClaudeTranscriptLocation,
} from './claude-subagent-meta';

let root = '';
let location: ClaudeTranscriptLocation;
let helperDir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aio-subagent-meta-'));
  const cwd = '/example/project';
  location = { cwd, sessionId: 'session-1', configDir: root };
  helperDir = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'session-1', 'subagents');
  mkdirSync(helperDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (name: string, body: unknown): void =>
  writeFileSync(join(helperDir, name), typeof body === 'string' ? body : JSON.stringify(body));

describe('Claude helper metadata', () => {
  it('returns only the whitelisted fork, depth, shape, model and type fields', () => {
    write('agent-a1.meta.json', {
      agentType: 'general-purpose', description: 'SECRET model-written text', requestShape: 'background',
      requestNonInteractive: true, spawnDepth: 2, isFork: true, model: 'sonnet', toolUseId: 'toolu_1',
      parentAgentId: 'a0',
    });
    const meta = readClaudeSubagentMeta(location, { agentId: 'a1' });
    expect(meta).toEqual({
      agentType: 'general-purpose', requestShape: 'background', spawnDepth: 2, isFork: true, requestedModel: 'sonnet',
    });
    expect(JSON.stringify(meta)).not.toContain('SECRET');
  });

  it('omits fields that are absent or of the wrong shape', () => {
    write('agent-a2.meta.json', { agentType: 42, requestShape: 'sideways', spawnDepth: -1, isFork: 'yes', model: '' });
    expect(readClaudeSubagentMeta(location, { agentId: 'a2' })).toEqual({});
  });

  it('rejects unsafe identifiers instead of building a path from them', () => {
    expect(readClaudeSubagentMeta(location, { agentId: '../a1' })).toBeUndefined();
    expect(readClaudeSubagentMeta({ ...location, sessionId: '../session-1' }, { agentId: 'a1' })).toBeUndefined();
    expect(readClaudeSubagentMeta(location, {})).toBeUndefined();
  });

  it('returns undefined for a missing, malformed or oversized file', () => {
    expect(readClaudeSubagentMeta(location, { agentId: 'nope' })).toBeUndefined();
    write('agent-bad.meta.json', '{not json');
    expect(readClaudeSubagentMeta(location, { agentId: 'bad' })).toBeUndefined();
    write('agent-big.meta.json', JSON.stringify({ agentType: 'x', description: 'y'.repeat(200_000) }));
    expect(readClaudeSubagentMeta(location, { agentId: 'big' })).toBeUndefined();
  });

  it('finds a helper by its tool-use id when the agent id was never seen', () => {
    write('agent-old.meta.json', { agentType: 'Explore', toolUseId: 'toolu_other', spawnDepth: 1 });
    write('agent-new.meta.json', { agentType: 'general-purpose', toolUseId: 'toolu_wanted', spawnDepth: 3, requestShape: 'foreground' });
    expect(readClaudeSubagentMeta(location, { toolUseId: 'toolu_wanted' })).toEqual({
      agentType: 'general-purpose', spawnDepth: 3, requestShape: 'foreground',
    });
    expect(readClaudeSubagentMeta(location, { toolUseId: 'toolu_missing' })).toBeUndefined();
  });

  it('reads the helper actual model from the end of its own transcript', () => {
    const line = (model: string | undefined, type = 'assistant') =>
      JSON.stringify({ type, message: model ? { model, usage: { input_tokens: 1 } } : {} });
    write('agent-a3.jsonl', [line('claude-opus-5-5'), line('<synthetic>'), line('claude-sonnet-5-5'), line(undefined, 'user'), '{partial'].join('\n'));
    expect(readClaudeSubagentTranscriptModel(location, { agentId: 'a3' })).toBe('claude-sonnet-5-5');
    expect(readClaudeSubagentTranscriptModel(location, { agentId: 'missing' })).toBeUndefined();
    expect(readClaudeSubagentTranscriptModel(location, { agentId: '../a3' })).toBeUndefined();
  });
});

describe('claudeSubagentTranscriptPath', () => {
  it('returns the helper transcript path when the file exists', () => {
    write('agent-a1.jsonl', '{"type":"assistant"}\n');
    expect(claudeSubagentTranscriptPath(location, 'a1')).toBe(join(helperDir, 'agent-a1.jsonl'));
  });

  it('returns undefined when the transcript is missing or the id is unsafe', () => {
    expect(claudeSubagentTranscriptPath(location, 'missing')).toBeUndefined();
    expect(claudeSubagentTranscriptPath(location, '../a1')).toBeUndefined();
    expect(claudeSubagentTranscriptPath({ ...location, sessionId: 'bad/id' }, 'a1')).toBeUndefined();
  });

  it('treats a directory where the transcript should be as missing', () => {
    mkdirSync(join(helperDir, 'agent-a1.jsonl'), { recursive: true });
    expect(claudeSubagentTranscriptPath(location, 'a1')).toBeUndefined();
  });
});

describe('sumClaudeSubagentTranscriptUsage', () => {
  const assistant = (id: string, model: string, usage: Record<string, unknown>): string =>
    JSON.stringify({ type: 'assistant', message: { id, model, usage } });

  it('sums usage across messages and splits 5-minute and 1-hour cache writes', () => {
    write('agent-a1.jsonl', [
      assistant('msg_1', 'claude-sonnet-5-5', {
        input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
      }),
      JSON.stringify({ type: 'user', message: { usage: { input_tokens: 9999 } } }),
      assistant('msg_2', 'claude-sonnet-5-5', {
        input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
      }),
    ].join('\n'));
    expect(sumClaudeSubagentTranscriptUsage(location, { agentId: 'a1' })).toEqual({
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 103, cacheWriteTokens: 54,
      cacheWrite5mTokens: 30, cacheWrite1hTokens: 20, models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
    });
  });

  it('counts one response written as several lines only once per message id', () => {
    write('agent-a2.jsonl', [
      assistant('msg_1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 5 }),
      assistant('msg_1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 5 }),
    ].join('\n'));
    expect(sumClaudeSubagentTranscriptUsage(location, { agentId: 'a2' })).toMatchObject({
      inputTokens: 10, outputTokens: 5, models: ['claude-sonnet-5-5'],
    });
  });

  it('records each model a message ran on and ignores <synthetic>', () => {
    write('agent-a3.jsonl', [
      assistant('msg_1', 'claude-opus-5-5', { input_tokens: 1 }),
      assistant('msg_2', '<synthetic>', { input_tokens: 1 }),
      assistant('msg_3', 'claude-sonnet-5-5', { input_tokens: 1 }),
    ].join('\n'));
    expect(sumClaudeSubagentTranscriptUsage(location, { agentId: 'a3' })).toMatchObject({
      inputTokens: 3, models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    });
  });

  it('returns undefined for a missing transcript or an unsafe id', () => {
    expect(sumClaudeSubagentTranscriptUsage(location, { agentId: 'missing' })).toBeUndefined();
    expect(sumClaudeSubagentTranscriptUsage(location, { agentId: '../a1' })).toBeUndefined();
  });

  it('gives up on an oversized transcript instead of reading it', () => {
    write('agent-big.jsonl', 'x'.repeat(10 * 1024 * 1024 + 1));
    expect(sumClaudeSubagentTranscriptUsage(location, { agentId: 'big' })).toBeUndefined();
  });
});
