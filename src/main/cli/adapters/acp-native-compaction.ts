/**
 * ACP-native compaction (A6.4, Step 11b).
 *
 * OpenCode 2.0.18 maps a `/compact` prompt to `client.session.compact`, so
 * "Compact now" can shrink the conversation in place instead of restarting
 * the session from a Harness summary. The adapter delegates to
 * `runAcpNativeCompaction` and falls back to restart-with-summary on any
 * failure (timeout, error, or a turn already in flight).
 *
 * The compaction notice carries `threadCompacted: true` so
 * `instance-event-forwarding` records the observed compaction, and
 * `compactionProof: 'acknowledged-only'` (the `opencode-acp` capability
 * profile below) states honestly that the only proof is the `/compact` turn
 * completing.
 */

import type { OutputMessage } from '../../../shared/types/instance.types';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import { generateId } from '../../../shared/utils/id-generator';
import type { CliMessage, CliResponse } from './base-cli-adapter';
import type { AcpContentBlock } from '../../../shared/types/cli.types';

/** Ordinary sendInput may resolve accepted failures through events; require the prompt result. */
export async function sendAcpCompactionCommand(
  command: string, send: (message: CliMessage) => Promise<CliResponse>,
): Promise<CliResponse> {
  const response = await send({ role: 'user', content: command });
  if (response.metadata?.['stopReason'] !== 'end_turn' || response.metadata?.['turnErrored'] === true) {
    throw new Error('ACP native compaction did not complete successfully.');
  }
  return response;
}

/**
 * OpenCode joins the visible text blocks and recognises a slash command only
 * at the very start (`packages/cli/src/acp/prompt.ts`, `detectSlashCommand`;
 * v2.0.18 `service.ts` `preparePrompt`). It runs `/compact` natively even when
 * the advertised command catalog omits it, but any block ahead of it (queued
 * context, a first-turn system prompt) makes the turn ordinary chat. A command
 * from the catalog, or the configured compaction command, is therefore sent as
 * the only prompt text; queued context and first-turn blocks wait for the next
 * real turn.
 */
export type AcpBareCommand = 'catalog' | 'compaction';

export function classifyAcpBareCommand(
  message: CliMessage, advertised: readonly { name: string }[] | undefined,
  compaction: AcpNativeCompactionConfig | undefined,
): AcpBareCommand | undefined {
  const name = /^\/([^\s]+)(?:\s|$)/.exec(message.content)?.[1];
  if (name && advertised?.some(command => command.name === name)) return 'catalog';
  return compaction && message.content === compaction.command && !message.attachments?.length ? 'compaction' : undefined;
}

/** The prompt for a bare command: the command text alone, no delivery diagnostics. */
export function bareAcpCommandPrompt(content: string): { prompt: AcpContentBlock[]; systemPromptDelivery: undefined } {
  return { prompt: [{ type: 'text', text: content }], systemPromptDelivery: undefined };
}

/**
 * A compaction turn carries no assistant answer text (OpenCode 2.0.18 streams
 * the summary as `session.compaction.delta`, which ACP does not forward). Text
 * means OpenCode ran an ordinary chat turn, so `end_turn` alone is not proof.
 */
export function acpCompactionAnsweredAsChat(response: CliResponse): boolean {
  return response.content.trim() !== '';
}

export interface AcpNativeCompactionConfig {
  /** The bare command sent as a normal later turn (e.g. `/compact`). */
  command: string;
  timeoutMs: number;
}

export interface AcpNativeCompactionPort {
  /** Absent means this adapter has no compaction command; returns false. */
  config: AcpNativeCompactionConfig | undefined;
  /** True while a `session/prompt` is in flight — never compact mid-turn. */
  isPromptInFlight: () => boolean;
  /** Send the bare command as a normal later turn; resolves at turn end. */
  sendCommand: (command: string) => Promise<void>;
  /** Emit the one system message that records the compaction. */
  emitCompactedNotice: (source: string) => void;
}

/** The system message a successful compaction (native or marker) emits. */
export function buildAcpThreadCompactedNotice(source: string): OutputMessage {
  const content = 'OpenCode compacted this conversation.';
  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content,
    metadata: {
      threadCompacted: true,
      providerCompaction: 'completed',
      source,
    },
  };
}

/**
 * The `opencode-acp` capability profile: the base ACP capabilities plus
 * OpenCode's own compaction. `providerAutoCompaction: 'inline'` is what
 * suspends Harness's occupancy actions for this provider.
 */
export function openCodeAcpContextCapabilities(
  base: ProviderContextCapabilities,
): ProviderContextCapabilities {
  return {
    ...base,
    transcriptControl: 'native-compaction',
    compactionProof: 'acknowledged-only',
    providerAutoCompaction: 'inline',
  };
}

/**
 * Send the compaction command and wait for the turn to complete. Returns
 * false (never throws) while a prompt is in flight, on timeout, or on error,
 * so the caller falls back to restart-with-summary as today.
 */
export async function runAcpNativeCompaction(port: AcpNativeCompactionPort): Promise<boolean> {
  const config = port.config;
  if (!config || port.isPromptInFlight()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('ACP native compaction timed out')), config.timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([port.sendCommand(config.command), timeout]);
    port.emitCompactedNotice('opencode-compact');
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Owns one native command's marker observation, including asynchronous turn cleanup. */
export class AcpNativeCompactionOperation<Turn> {
  private active: { turn: Turn | null; failed: boolean } | null = null;

  bindTurn(turn: Turn, content: string, command: string | undefined): void {
    if (this.active && !this.active.turn && content === command) this.active.turn = turn;
  }

  fail(currentTurn: Turn | null): void {
    if (this.active?.turn && this.active.turn === currentTurn) this.active.failed = true;
  }

  async run(port: {
    config: AcpNativeCompactionConfig | undefined;
    currentTurn: () => Turn | null;
    isPromptInFlight: () => boolean;
    send: (message: CliMessage) => Promise<CliResponse>;
    observe: (listener: (message: OutputMessage) => void) => () => void;
    emit: (message: OutputMessage) => void;
  }): Promise<boolean> {
    if (this.active) return false;
    const operation = { turn: null as Turn | null, failed: false };
    this.active = operation;
    let observed = false;
    const unsubscribe = port.observe(message => {
      if (operation.turn && operation.turn === port.currentTurn()
        && message.metadata?.['threadCompacted'] === true) observed = true;
    });
    try {
      return await runAcpNativeCompaction({
        config: port.config,
        isPromptInFlight: port.isPromptInFlight,
        sendCommand: async command => {
          const response = await sendAcpCompactionCommand(command, port.send);
          if (operation.failed) throw new Error('The provider reported that native compaction failed.');
          if (!observed && acpCompactionAnsweredAsChat(response)) {
            throw new Error('OpenCode answered the compaction command as an ordinary chat turn.');
          }
        },
        emitCompactedNotice: source => {
          if (!observed) port.emit(buildAcpThreadCompactedNotice(source));
        },
      });
    } finally {
      unsubscribe();
      if (this.active === operation) this.active = null;
    }
  }
}

/** ACP capability profiles share the same measured-occupancy override. */
export function resolveAcpContextCapabilities(
  base: ProviderContextCapabilities,
  profile: string | undefined,
  measuredOccupancy: boolean,
): ProviderContextCapabilities {
  if (profile === 'copilot-acp') {
    return {
      toolResultControl: 'post-retention', toolResultVisibility: 'full',
      transcriptControl: 'none', occupancyReporting: 'aggregate-only',
      cumulativeReporting: 'available', interruptProof: 'none',
      compactionProof: 'none', sameThreadContinuation: false,
    };
  }
  const effective = measuredOccupancy ? { ...base, occupancyReporting: 'current' as const } : base;
  return profile === 'opencode-acp' ? openCodeAcpContextCapabilities(effective) : effective;
}
