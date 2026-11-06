import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readClaudeSubagentMeta,
  readClaudeSubagentTranscriptModel,
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
