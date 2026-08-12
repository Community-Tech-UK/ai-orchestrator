/**
 * LT-062: `output`-message bridge for the WS-A2 tool-loop detector.
 *
 * `bindRawAdapterProviderEvents()` only ever sees a raw `tool_use`/
 * `tool_result` `EventEmitter` event from `AcpCliAdapter` (Copilot/Cursor/
 * Grok). Every other built-in adapter (Claude, Codex, Gemini, Antigravity,
 * Ollama) surfaces tool activity as `output` messages instead, which used
 * to be silently dropped by `observeToolLoopEvent()` because it only
 * matched `event.kind === 'tool_use' | 'tool_result'`. These tests exercise
 * `observeToolLoopEvent()` directly against the real `DoomLoopDetector`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { observeToolLoopEvent, type ToolLoopWiringDeps } from './instance-tool-loop-wiring';
import { DoomLoopDetector, getDoomLoopDetector, type ToolLoopDetectionEvent } from '../orchestration/doom-loop-detector';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';

const noopDeps: ToolLoopWiringDeps = {
  getAutoInterruptSetting: () => false,
  interruptInstance: () => true,
};

function collectDetections(): ToolLoopDetectionEvent[] {
  const events: ToolLoopDetectionEvent[] = [];
  getDoomLoopDetector().on('tool-loop-detected', (event: ToolLoopDetectionEvent) => events.push(event));
  return events;
}

/** A Claude assistant-content-block `tool_use` output message, as `claude-cli-adapter.ts` emits it. */
function claudeToolUseOutput(callId: string, command: string): ProviderRuntimeEvent {
  return {
    kind: 'output',
    content: 'Using tool: Bash',
    messageType: 'tool_use',
    metadata: { name: 'Bash', id: callId, input: { command } },
  };
}

/** What `bindRawAdapterProviderEvents()` produces from the LT-062 raw `tool_result` emit added to `claude-cli-adapter.ts`. */
function rawToolResult(callId: string, output: string): ProviderRuntimeEvent {
  return { kind: 'tool_result', toolName: 'Bash', toolUseId: callId, success: true, output };
}

/** An ACP `output` echo of a tool_use/tool_result `acp-cli-adapter.ts` also raw-emits (must not be double-counted). */
function acpToolUseOutput(callId: string, kind: string): ProviderRuntimeEvent {
  return {
    kind: 'output',
    content: 'title',
    messageType: 'tool_use',
    metadata: { toolCallId: callId, kind, name: kind, transport: 'acp' },
  };
}

describe('LT-062: observeToolLoopEvent output-message bridge', () => {
  afterEach(() => {
    DoomLoopDetector._resetForTesting();
  });

  it('bridges a Claude-shaped tool_use output paired with a raw tool_result and fires repeat-no-progress', () => {
    const detections = collectDetections();

    for (let i = 0; i < 3; i++) {
      observeToolLoopEvent(noopDeps, 'inst-1', claudeToolUseOutput(`c${i}`, 'cat watch.txt'));
      observeToolLoopEvent(noopDeps, 'inst-1', rawToolResult(`c${i}`, 'unchanged contents'));
    }

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ detector: 'repeat-no-progress', severity: 'warn', toolName: 'Bash', count: 3 });
  });

  it('does not fire when the bridged command genuinely changes each call', () => {
    const detections = collectDetections();
    const commands = ['cat a.txt', 'cat b.txt', 'cat c.txt'];

    for (let i = 0; i < commands.length; i++) {
      observeToolLoopEvent(noopDeps, 'inst-1', claudeToolUseOutput(`c${i}`, commands[i]));
      observeToolLoopEvent(noopDeps, 'inst-1', rawToolResult(`c${i}`, 'some output'));
    }

    expect(detections).toHaveLength(0);
  });

  it('does not double-count an ACP output echo alongside its own raw tool_use event', () => {
    const detections = collectDetections();

    // acp-cli-adapter.ts emits BOTH a raw 'tool_use' EventEmitter event and an
    // 'output' echo (metadata.transport === 'acp') for the SAME call — as
    // bindRawAdapterProviderEvents() + InstanceManager.publishOutput() would
    // both deliver in production. Only the raw event may reach the detector.
    for (let i = 0; i < 3; i++) {
      const raw: ProviderRuntimeEvent = { kind: 'tool_use', toolName: 'edit', toolUseId: `c${i}`, input: { path: '/tmp/x' } };
      observeToolLoopEvent(noopDeps, 'inst-1', raw);
      observeToolLoopEvent(noopDeps, 'inst-1', acpToolUseOutput(`c${i}`, 'edit'));
      observeToolLoopEvent(noopDeps, 'inst-1', { kind: 'tool_result', toolName: 'edit', toolUseId: `c${i}`, success: true, output: 'same' });
    }

    // repeat-no-progress' own count is the proof: if the ACP output echo
    // were also counted, 3 rounds would produce 6 recorded tool_use/result
    // pairs and the chain would already have escalated past the warn-only
    // count of 3 (escalationMultiplier 2 => critical at 6).
    expect(detections.filter((e) => e.detector === 'repeat-no-progress')).toHaveLength(1);
    expect(detections[0]).toMatchObject({ detector: 'repeat-no-progress', severity: 'warn', count: 3 });
  });

  it('still counts a Codex-shaped tool_use output (no correlation id) toward runaway, fail-open on pairing', () => {
    const detections = collectDetections();
    // Codex's real-time command-execution tool_use item carries no id at all
    // (codex-app-server-notification-adapter.ts) — the bridge cannot invent
    // one, so it must fail open on pairing while still counting the call.
    const codexToolUse: ProviderRuntimeEvent = {
      kind: 'output',
      content: 'Running command: cat watch.txt',
      messageType: 'tool_use',
      metadata: { name: 'Bash', streaming: true, phase: 'running' },
    };

    // Default runawayCap is 200 (escalationMultiplier 2) on the process-wide
    // singleton observeToolLoopEvent() resolves; 200 identical calls proves
    // the counter, not a custom-configured detector instance.
    for (let i = 0; i < 200; i++) {
      observeToolLoopEvent(noopDeps, 'inst-1', codexToolUse);
    }

    expect(detections.filter((e) => e.detector === 'runaway')).toHaveLength(1);
    expect(detections.filter((e) => e.detector === 'repeat-no-progress')).toHaveLength(0);
  });

  it('does not inflate the runaway counter with an ACP output echo', () => {
    // Consolidation-review finding: the sibling test above cannot actually
    // detect a regression in the `transport === 'acp'` gate. `pendingByCallId`
    // is a Map keyed by callId, so a duplicate echo just OVERWRITES the pending
    // entry — pairing can never double-count, gate or no gate.
    //
    // `state.totalToolCalls++` is what the gate really protects: it runs
    // unconditionally on every recordToolUse, so an ungated echo counts each
    // ACP call TWICE toward `runaway`, silently halving the effective cap for
    // Copilot/Cursor/Grok. This asserts on that counter instead.
    //
    // 100 raw calls + 100 echoes = 200 = runawayCap if the echo is counted;
    // with the gate, only 100 are counted and nothing fires.
    const detections = collectDetections();

    for (let i = 0; i < 100; i++) {
      observeToolLoopEvent(noopDeps, 'inst-1', {
        kind: 'tool_use', toolName: 'edit', toolUseId: `r${i}`, input: { path: `/tmp/${i}` },
      });
      observeToolLoopEvent(noopDeps, 'inst-1', acpToolUseOutput(`r${i}`, 'edit'));
    }

    expect(detections.filter((e) => e.detector === 'runaway')).toHaveLength(0);
  });

  it('ignores an output message that is not tool_use/tool_result-typed', () => {
    const detections = collectDetections();
    observeToolLoopEvent(noopDeps, 'inst-1', { kind: 'output', content: 'hello', messageType: 'assistant' });
    expect(detections).toHaveLength(0);
  });
});
