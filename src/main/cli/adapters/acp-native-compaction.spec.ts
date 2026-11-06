import { describe, expect, it } from 'vitest';
import { CONSERVATIVE_PROVIDER_CONTEXT_CAPABILITIES } from '@contracts/types/context-evidence';
import {
  acpCompactionAnsweredAsChat,
  bareAcpCommandPrompt,
  buildAcpThreadCompactedNotice,
  classifyAcpBareCommand,
  openCodeAcpContextCapabilities,
  runAcpNativeCompaction,
  type AcpNativeCompactionPort,
} from './acp-native-compaction';

function makePort(overrides: Partial<AcpNativeCompactionPort> = {}): AcpNativeCompactionPort & {
  sent: string[];
  notices: string[];
} {
  const sent: string[] = [];
  const notices: string[] = [];
  return {
    sent,
    notices,
    config: { command: '/compact', timeoutMs: 50 },
    isPromptInFlight: () => false,
    sendCommand: async (command) => { sent.push(command); },
    emitCompactedNotice: (source) => { notices.push(source); },
    ...overrides,
  };
}

describe('runAcpNativeCompaction', () => {
  it('sends exactly /compact as a later turn', async () => {
    const port = makePort();
    await expect(runAcpNativeCompaction(port)).resolves.toBe(true);
    expect(port.sent).toEqual(['/compact']);
    expect(port.notices).toEqual(['opencode-compact']);
  });

  it('refuses while a prompt is in flight', async () => {
    const port = makePort({ isPromptInFlight: () => true });
    await expect(runAcpNativeCompaction(port)).resolves.toBe(false);
    expect(port.sent).toEqual([]);
  });

  it('emits a typed completion notice', () => {
    const notice = buildAcpThreadCompactedNotice('opencode-compact');
    expect(notice.id).toBeTruthy();
    expect(notice.timestamp).toEqual(expect.any(Number));
    expect(notice.type).toBe('system');
    expect(notice.content).toBe('OpenCode compacted this conversation.');
    expect(notice.metadata).toEqual({ threadCompacted: true, providerCompaction: 'completed', source: 'opencode-compact' });
  });

  it('returns false on timeout or error', async () => {
    const timedOut = makePort({ config: { command: '/compact', timeoutMs: 10 }, sendCommand: () => new Promise(() => undefined) });
    await expect(runAcpNativeCompaction(timedOut)).resolves.toBe(false);
    const failed = makePort({ sendCommand: async () => { throw new Error('turn failed'); } });
    await expect(runAcpNativeCompaction(failed)).resolves.toBe(false);
    expect(timedOut.notices).toEqual([]);
    expect(failed.notices).toEqual([]);
  });
});

describe('openCodeAcpContextCapabilities', () => {
  it('reports acknowledged native compaction and inline auto compaction', () => {
    const caps = openCodeAcpContextCapabilities(CONSERVATIVE_PROVIDER_CONTEXT_CAPABILITIES);
    expect(caps.transcriptControl).toBe('native-compaction');
    expect(caps.compactionProof).toBe('acknowledged-only');
    expect(caps.providerAutoCompaction).toBe('inline');
  });
});

describe('classifyAcpBareCommand', () => {
  const compaction = { command: '/compact', timeoutMs: 50 };
  const user = (content: string) => ({ role: 'user' as const, content });

  it('treats an advertised command as bare, whether or not compaction is configured', () => {
    expect(classifyAcpBareCommand(user('/review src'), [{ name: 'review' }], undefined)).toBe('catalog');
    expect(classifyAcpBareCommand(user('/compact'), [{ name: 'compact' }], compaction)).toBe('catalog');
  });

  it('treats the configured compaction command as bare even when the catalog omits it', () => {
    expect(classifyAcpBareCommand(user('/compact'), [{ name: 'init' }], compaction)).toBe('compaction');
    expect(classifyAcpBareCommand(user('/compact'), undefined, compaction)).toBe('compaction');
  });

  it('leaves ordinary text, other slash text, and unconfigured compaction as ordinary turns', () => {
    expect(classifyAcpBareCommand(user('please /compact'), [], compaction)).toBeUndefined();
    expect(classifyAcpBareCommand(user('/compact now'), [], compaction)).toBeUndefined();
    expect(classifyAcpBareCommand(user('/other'), [{ name: 'init' }], compaction)).toBeUndefined();
    expect(classifyAcpBareCommand(user('/compact'), [], undefined)).toBeUndefined();
  });

  it('builds the command as the only text block with no system-prompt delivery', () => {
    expect(bareAcpCommandPrompt('/compact')).toEqual({ prompt: [{ type: 'text', text: '/compact' }], systemPromptDelivery: undefined });
  });
});

describe('acpCompactionAnsweredAsChat', () => {
  it('flags assistant answer text and ignores empty or whitespace-only content', () => {
    const response = (content: string) => ({ id: 'r', role: 'assistant' as const, content });
    expect(acpCompactionAnsweredAsChat(response('Sure, here you go.'))).toBe(true);
    expect(acpCompactionAnsweredAsChat(response(''))).toBe(false);
    expect(acpCompactionAnsweredAsChat(response('  \n'))).toBe(false);
  });
});
