import { describe, expect, it } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { AcpContentBlock, AcpSessionPromptParams } from '../../../shared/types/cli.types';
import type { OutputMessage } from '../../../shared/types/instance.types';

// OpenCode (packages/cli/src/acp/prompt.ts `detectSlashCommand`, v2.0.18 service.ts `preparePrompt`) joins the
// visible text blocks and recognises a slash command only at the START of that text. It runs `/compact`
// natively even though its advertised catalog (init/review/MCP/config commands) never lists "compact".
// Any block ahead of `/compact` therefore turns the compaction into an ordinary chat turn.
const REAL_2_0_18_COMMANDS = [{ name: 'init', description: '' }, { name: 'review', description: '' }];
const NOTICE = '[Harness runtime change notice] The model was switched.';

type Prompt = AcpContentBlock[];

function setup(config: Record<string, unknown> = {}) {
  const proc = createInitializedAgentHarness();
  const adapter = new TestAcpCliAdapter(proc, {
    command: 'acp-placeholder', workingDirectory: '/tmp', systemPrompt: 'fixture instructions',
    nativeCompaction: { command: '/compact', timeoutMs: 1000 }, promptTimeoutMs: 30, ...config,
  });
  adapter.configureOpenCodeV2(true);
  const output: OutputMessage[] = [];
  adapter.on('output', message => output.push(message));
  adapter.on('status', () => undefined);
  adapter.on('error', () => undefined);
  const prompts: Prompt[] = [];
  let beforeEnd: () => void = () => undefined;
  proc.onRequest('session/prompt', request => {
    prompts.push((request.params as AcpSessionPromptParams).prompt);
    beforeEnd();
    proc.respond(request.id, { stopReason: 'end_turn' });
  });
  const advertise = (availableCommands: { name: string; description?: string }[]) =>
    proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'available_commands_update', availableCommands } });
  return {
    proc, adapter, output, prompts, advertise,
    onPromptEnd: (callback: () => void) => { beforeEnd = callback; },
    compacted: () => output.filter(message => message.metadata?.['threadCompacted']),
    finish: async () => { proc.exit(); await adapter.terminate(false); },
  };
}

const texts = (prompt: Prompt) => prompt.map(block => (block.type === 'text' ? block.text : `<${block.type}>`));

describe('native compaction prompt shape (OpenCode only detects a leading /compact)', () => {
  it('sends /compact as the only prompt text when a runtime-change notice is queued, and keeps the notice for the next real turn', async () => {
    const t = setup();
    try {
      await t.adapter.spawn();
      await t.adapter.sendInput('ordinary first turn');
      t.advertise(REAL_2_0_18_COMMANDS);
      t.adapter.queueNextPromptContext(NOTICE);

      await expect(t.adapter.compactContext()).resolves.toBe(true);
      expect(texts(t.prompts[1]!)).toEqual(['/compact']);
      expect(t.compacted()).toHaveLength(1);

      await t.adapter.sendInput('next real turn');
      expect(texts(t.prompts[2]!)).toEqual([NOTICE, 'next real turn']);
      await t.adapter.sendInput('and another');
      expect(texts(t.prompts[3]!)).toEqual(['and another']);
    } finally { await t.finish(); }
  });

  it('holds the first-turn system prompt for the next real turn when /compact is the very first prompt', async () => {
    const t = setup();
    try {
      await t.adapter.spawn();
      t.advertise(REAL_2_0_18_COMMANDS);
      await expect(t.adapter.compactContext()).resolves.toBe(true);
      expect(texts(t.prompts[0]!)).toEqual(['/compact']);

      await t.adapter.sendInput('first real turn');
      const first = texts(t.prompts[1]!);
      expect(first).toHaveLength(2);
      expect(first[0]).toContain('fixture instructions');
      expect(first[1]).toBe('first real turn');

      await t.adapter.sendInput('second real turn');
      expect(texts(t.prompts[2]!)).toEqual(['second real turn']);
    } finally { await t.finish(); }
  });

  it('keeps the normal case unchanged: a catalogued /compact is bare, and ordinary turns still carry queued context', async () => {
    const t = setup();
    try {
      await t.adapter.spawn();
      await t.adapter.sendInput('ordinary first turn');
      t.advertise([...REAL_2_0_18_COMMANDS, { name: 'compact', description: 'Compact the session' }]);
      await expect(t.adapter.compactContext()).resolves.toBe(true);
      expect(texts(t.prompts[1]!)).toEqual(['/compact']);

      t.adapter.queueNextPromptContext(NOTICE);
      await t.adapter.sendInput('an ordinary question');
      expect(texts(t.prompts[2]!)).toEqual([NOTICE, 'an ordinary question']);
    } finally { await t.finish(); }
  });

  it('does not report success when OpenCode answers the command with ordinary chat text', async () => {
    const t = setup();
    try {
      await t.adapter.spawn();
      await t.adapter.sendInput('ordinary first turn');
      t.advertise(REAL_2_0_18_COMMANDS);
      t.onPromptEnd(() => t.proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Sure, here is a chat answer.' } } }));
      await expect(t.adapter.compactContext()).resolves.toBe(false);
      expect(t.compacted()).toHaveLength(0);
    } finally { await t.finish(); }
  });

  it('still reports success for a silent end_turn (OpenCode 2.0.18 streams no assistant text for a compaction)', async () => {
    const t = setup();
    try {
      await t.adapter.spawn();
      await t.adapter.sendInput('ordinary first turn');
      await expect(t.adapter.compactContext()).resolves.toBe(true);
      expect(t.compacted()).toHaveLength(1);
    } finally { await t.finish(); }
  });

  describe('catalog changes while the prompt is being prepared', () => {
    function withCatalogDroppedDuringPrepare() {
      let drop: () => void = () => undefined;
      const t = setup({ beforeProviderPrompt: async () => { drop(); await new Promise(resolve => setTimeout(resolve, 20)); } });
      drop = () => t.advertise([]);
      return t;
    }

    it('refuses a catalogued native command that disappeared from the catalog', async () => {
      const t = withCatalogDroppedDuringPrepare();
      try {
        await t.adapter.spawn();
        t.advertise([{ name: 'review', description: '' }]);
        await new Promise(resolve => setTimeout(resolve, 20));
        await expect(t.adapter.sendMessage({ role: 'user', content: '/review' })).rejects.toThrow('no longer available');
        expect(t.prompts).toHaveLength(0);
      } finally { await t.finish(); }
    });

    it('still sends the configured compaction command that was never in the catalog', async () => {
      const t = withCatalogDroppedDuringPrepare();
      try {
        await t.adapter.spawn();
        t.advertise(REAL_2_0_18_COMMANDS);
        await new Promise(resolve => setTimeout(resolve, 20));
        await expect(t.adapter.compactContext()).resolves.toBe(true);
        expect(texts(t.prompts[0]!)).toEqual(['/compact']);
      } finally { await t.finish(); }
    });
  });
});
