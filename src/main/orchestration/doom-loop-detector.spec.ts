import { describe, it, expect, afterEach } from 'vitest';
import {
  DoomLoopDetector,
  getDoomLoopDetector,
  type ToolLoopDetectionEvent,
} from './doom-loop-detector';
import {
  toProviderToolResultObservedEvent,
  toProviderToolUseObservedEvent,
} from '../providers/adapter-runtime-event-bridge';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';

describe('DoomLoopDetector', () => {
  afterEach(() => {
    DoomLoopDetector._resetForTesting();
  });

  describe('repeat-no-progress', () => {
    it('warns after N consecutive identical (tool, args, result) pairs', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 3, escalationMultiplier: 2 });
      const events: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 3; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        events.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        instanceId: 'inst-1',
        detector: 'repeat-no-progress',
        severity: 'warn',
        toolName: 'read_file',
        count: 3,
      });
    });

    it('escalates to critical at 2x the threshold and fires exactly once', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 3, escalationMultiplier: 2 });
      const all: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 8; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }

      const warns = all.filter((e) => e.severity === 'warn');
      const criticals = all.filter((e) => e.severity === 'critical');
      expect(warns).toHaveLength(1);
      expect(criticals).toHaveLength(1);
      expect(criticals[0].count).toBe(6);
    });

    it('a changing result hash is progress and resets the chain (never flags polling)', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 3 });
      const all: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 20; i++) {
        detector.recordToolUse('inst-1', { toolName: 'poll_status', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: `r${i}` }));
      }

      expect(all).toHaveLength(0);
    });

    it('warn-once semantics: does not re-warn the same signature within a turn', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 3, escalationMultiplier: 100 });
      const all: ToolLoopDetectionEvent[] = [];

      // Reach the chain, break it, then reach the exact same signature again.
      for (let i = 0; i < 3; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }
      detector.recordToolUse('inst-1', { toolName: 'other_tool', callId: 'break', argsHash: 'ab' });
      all.push(...detector.recordToolResult('inst-1', { callId: 'break', resultHash: 'rb' }));
      for (let i = 3; i < 6; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }

      expect(all.filter((e) => e.severity === 'warn')).toHaveLength(1);
    });

    it('resets on turn boundaries so the same signature can warn again next turn', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 3, escalationMultiplier: 100 });
      const all: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 3; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }
      detector.notifyTurnEnd('inst-1');
      detector.notifyTurnStart('inst-1');
      for (let i = 3; i < 6; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }

      expect(all.filter((e) => e.severity === 'warn')).toHaveLength(2);
    });
  });

  describe('ping-pong', () => {
    it('warns when the window alternates between two signatures with unchanged results', () => {
      const detector = new DoomLoopDetector({ pingPongWindow: 6, escalationMultiplier: 2 });
      const all: ToolLoopDetectionEvent[] = [];
      const seq = ['toolA', 'toolB', 'toolA', 'toolB', 'toolA', 'toolB'];

      seq.forEach((toolName, i) => {
        const argsHash = toolName === 'toolA' ? 'argsA' : 'argsB';
        const resultHash = toolName === 'toolA' ? 'resultA' : 'resultB';
        detector.recordToolUse('inst-1', { toolName, callId: `c${i}`, argsHash });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash }));
      });

      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ detector: 'ping-pong', severity: 'warn', count: 6 });
    });

    it('does not flag three distinct alternating tools (not a 2-way ping-pong)', () => {
      const detector = new DoomLoopDetector({ pingPongWindow: 6 });
      const all: ToolLoopDetectionEvent[] = [];
      const seq = ['toolA', 'toolB', 'toolC', 'toolA', 'toolB', 'toolC'];

      seq.forEach((toolName, i) => {
        detector.recordToolUse('inst-1', { toolName, callId: `c${i}`, argsHash: `args-${toolName}` });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: `result-${toolName}` }));
      });

      expect(all).toHaveLength(0);
    });
  });

  describe('runaway', () => {
    it('warns once the total tool-call cap is crossed', () => {
      const detector = new DoomLoopDetector({ runawayCap: 5, escalationMultiplier: 2 });
      const all: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 5; i++) {
        all.push(...detector.recordToolUse('inst-1', { toolName: `tool-${i}` }));
      }

      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ detector: 'runaway', severity: 'warn', count: 5 });
    });

    it('escalates to critical at 2x the cap', () => {
      const detector = new DoomLoopDetector({ runawayCap: 5, escalationMultiplier: 2 });
      const all: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 10; i++) {
        all.push(...detector.recordToolUse('inst-1', { toolName: `tool-${i}` }));
      }

      expect(all.filter((e) => e.severity === 'critical')).toHaveLength(1);
    });
  });

  describe('post-compaction canary', () => {
    it('uses the stricter canary threshold for calls within the armed window', () => {
      const detector = new DoomLoopDetector({
        repeatThreshold: 5,
        canaryRepeatThreshold: 2,
        canaryCallWindow: 2,
        escalationMultiplier: 100,
      });
      const all: ToolLoopDetectionEvent[] = [];

      detector.notifyCompaction('inst-1');
      for (let i = 0; i < 2; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }

      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ detector: 'repeat-no-progress', severity: 'warn', count: 2 });
      expect(all[0].windowDescription).toContain('canary');
    });

    it('expires after the canary window and falls back to the normal threshold', () => {
      const detector = new DoomLoopDetector({
        repeatThreshold: 5,
        canaryRepeatThreshold: 2,
        canaryCallWindow: 2,
        escalationMultiplier: 100,
      });
      const all: ToolLoopDetectionEvent[] = [];

      detector.notifyCompaction('inst-1');
      // Consume the 2-call canary window with a distinct signature.
      for (let i = 0; i < 2; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `warmup-${i}`, argsHash: 'warmup' });
        all.push(...detector.recordToolResult('inst-1', { callId: `warmup-${i}`, resultHash: 'warmup-r' }));
      }
      all.length = 0;

      // 3 more identical calls: below the normal threshold of 5.
      for (let i = 0; i < 3; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }

      expect(all).toHaveLength(0);
    });
  });

  describe('fail-open', () => {
    it('records nothing for repeat-no-progress when argsHash is missing', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 2 });
      const all: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 5; i++) {
        all.push(...detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}` }));
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}`, resultHash: 'r1' }));
      }

      expect(all.filter((e) => e.detector !== 'runaway')).toHaveLength(0);
    });

    it('records nothing when resultHash is missing', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 2 });
      const all: ToolLoopDetectionEvent[] = [];

      for (let i = 0; i < 5; i++) {
        detector.recordToolUse('inst-1', { toolName: 'read_file', callId: `c${i}`, argsHash: 'a1' });
        all.push(...detector.recordToolResult('inst-1', { callId: `c${i}` }));
      }

      expect(all).toHaveLength(0);
    });

    it('records nothing when there is no matching pending tool_use', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 1 });
      const result = detector.recordToolResult('inst-1', { callId: 'unknown-call', resultHash: 'r1' });
      expect(result).toHaveLength(0);
    });

    it('still counts toward runaway even without a callId/argsHash', () => {
      const detector = new DoomLoopDetector({ runawayCap: 2, escalationMultiplier: 2 });
      const all: ToolLoopDetectionEvent[] = [];
      all.push(...detector.recordToolUse('inst-1', { toolName: 'read_file' }));
      all.push(...detector.recordToolUse('inst-1', { toolName: 'read_file' }));
      expect(all.filter((e) => e.detector === 'runaway')).toHaveLength(1);
    });
  });

  describe('turn reset', () => {
    it('resets total tool calls for runaway on turn start', () => {
      const detector = new DoomLoopDetector({ runawayCap: 3, escalationMultiplier: 2 });
      for (let i = 0; i < 3; i++) {
        detector.recordToolUse('inst-1', { toolName: `t${i}` });
      }
      detector.notifyTurnEnd('inst-1');
      detector.notifyTurnStart('inst-1');

      const all = detector.recordToolUse('inst-1', { toolName: 'fresh' });
      expect(all).toHaveLength(0);
    });

    it('is a no-op for an instance with no tracked state', () => {
      const detector = new DoomLoopDetector();
      expect(() => detector.notifyTurnStart('never-seen')).not.toThrow();
      expect(() => detector.notifyTurnEnd('never-seen')).not.toThrow();
    });
  });

  describe('auto-interrupt idempotency guard', () => {
    it('is false until markAutoInterrupted is called, then true for the rest of the turn', () => {
      const detector = new DoomLoopDetector();
      expect(detector.hasAutoInterruptedThisTurn('inst-1')).toBe(false);
      detector.markAutoInterrupted('inst-1');
      expect(detector.hasAutoInterruptedThisTurn('inst-1')).toBe(true);
    });

    it('resets on turn boundaries', () => {
      const detector = new DoomLoopDetector();
      detector.markAutoInterrupted('inst-1');
      detector.notifyTurnEnd('inst-1');
      expect(detector.hasAutoInterruptedThisTurn('inst-1')).toBe(false);
    });
  });

  describe('cleanupInstance', () => {
    it('clears tracked state for the instance', () => {
      const detector = new DoomLoopDetector({ repeatThreshold: 2, escalationMultiplier: 100 });
      detector.recordToolUse('inst-1', { toolName: 'read_file', callId: 'c1', argsHash: 'a1' });
      detector.recordToolResult('inst-1', { callId: 'c1', resultHash: 'r1' });
      detector.cleanupInstance('inst-1');

      const all: ToolLoopDetectionEvent[] = [];
      detector.recordToolUse('inst-1', { toolName: 'read_file', callId: 'c2', argsHash: 'a1' });
      all.push(...detector.recordToolResult('inst-1', { callId: 'c2', resultHash: 'r1' }));
      expect(all).toHaveLength(0);
    });
  });

  describe('singleton', () => {
    it('getDoomLoopDetector() returns the same instance', () => {
      expect(getDoomLoopDetector()).toBe(getDoomLoopDetector());
    });

    it('_resetForTesting() clears the singleton and its listeners', () => {
      const first = getDoomLoopDetector();
      let calls = 0;
      first.on('tool-loop-detected', () => calls++);
      DoomLoopDetector._resetForTesting();
      const second = getDoomLoopDetector();
      expect(second).not.toBe(first);
      second.recordToolUse('inst-x', { toolName: 't' });
      expect(calls).toBe(0);
    });
  });

  describe('instance isolation', () => {
    it('tracks separate instances independently', () => {
      const detector = new DoomLoopDetector({ runawayCap: 2, escalationMultiplier: 2 });
      detector.recordToolUse('inst-A', { toolName: 't' });
      detector.recordToolUse('inst-A', { toolName: 't' });
      const eventsB = detector.recordToolUse('inst-B', { toolName: 't' });
      expect(eventsB).toHaveLength(0);
    });
  });
});

describe('LT-061: realistic Bash polling loop through the full observation pipeline', () => {
  /** Runs a Bash tool_use/tool_result pair through the real WS-B10 normalizer, as production wiring does. */
  function recordBashCall(
    detector: DoomLoopDetector,
    instanceId: string,
    callId: string,
    command: string,
    description: string,
    result: string,
  ): ToolLoopDetectionEvent[] {
    const toolCall: CliToolCall = { id: callId, name: 'Bash', arguments: { command, description }, result };
    const useObservation = toProviderToolUseObservedEvent(toolCall);
    const events = detector.recordToolUse(instanceId, {
      toolName: useObservation.toolName,
      callId: useObservation.callId,
      argsHash: useObservation.argsHash,
    });
    const resultObservation = toProviderToolResultObservedEvent(toolCall);
    events.push(
      ...detector.recordToolResult(instanceId, {
        callId: resultObservation.callId,
        resultHash: resultObservation.resultHash,
      }),
    );
    return events;
  }

  it('fires repeat-no-progress for an identical command whose description text varies each call', () => {
    const detector = new DoomLoopDetector({ repeatThreshold: 3, escalationMultiplier: 2 });
    const all: ToolLoopDetectionEvent[] = [];

    for (let i = 1; i <= 3; i++) {
      all.push(
        ...recordBashCall(
          detector,
          'inst-1',
          `c${i}`,
          'cat /tmp/watch.txt',
          `Read watch.txt (${i}/8)`,
          'unchanged file contents',
        ),
      );
    }

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ detector: 'repeat-no-progress', severity: 'warn', toolName: 'Bash', count: 3 });
  });

  it('does not fire when the command genuinely changes even with formulaic description text', () => {
    const detector = new DoomLoopDetector({ repeatThreshold: 3, escalationMultiplier: 2 });
    const all: ToolLoopDetectionEvent[] = [];
    const commands = ['cat /tmp/a.txt', 'cat /tmp/b.txt', 'cat /tmp/c.txt'];

    for (let i = 0; i < commands.length; i++) {
      all.push(
        ...recordBashCall(detector, 'inst-1', `c${i}`, commands[i], `Step (${i + 1}/3)`, 'some output'),
      );
    }

    expect(all).toHaveLength(0);
  });
});
