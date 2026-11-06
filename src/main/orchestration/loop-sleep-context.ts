/**
 * A loop that is about to sleep for a known time starts fresh instead of re-reading its whole
 * conversation afterwards (Oct-2 T13.1).
 *
 * A loop sleeps on a scheduled wake-up (it asked to be resumed at a time) or on a provider
 * limit (it resumes when the allowance resets). Either way the wake-up time is known. If the
 * loop's own Claude session holds 200K or more and the sleep outlasts the prompt cache, the
 * next iteration is asked to start in a new session: the loop already re-anchors a new session
 * from its hand-off note, and nothing here needs the provider to answer, which matters on a
 * quota park. A loop that ran inside a person's chat session has no session of its own; on a
 * scheduled wake-up that chat is handed to the general pre-sleep compaction instead.
 */

import type { ContextUsageObservation } from '../cli/adapters/base-cli-adapter.types';
import { getClaudeCacheLifetime } from '../cli/adapters/claude-cache-lifetime';
import { decideSleepContext } from '../../shared/utils/claude-cache-economics';
import { getLogger } from '../logging/logger';
import { getPreSleepContext } from '../context/pre-sleep-context';

const logger = getLogger('LoopSleepContext');

export interface LoopSleepCoordinator {
  on(event: string, listener: (payload: unknown) => void): unknown;
  getLoop?(loopRunId: string): { chatId?: string } | undefined;
  requestContextReset?(loopRunId: string): void;
}

export interface LoopSleepDeps {
  coordinator: LoopSleepCoordinator;
  /** The loop's own long-lived session, when it has one. */
  getPersistentAdapter(loopRunId: string): unknown;
  /** True when the loop ran inside the person's chat session instead of its own. */
  isBorrowedChat(loopRunId: string): boolean;
  /** A borrowed chat session will sleep until `wakeAt`. Defaults to the general pre-sleep compaction. */
  noteChatSleep?(chatId: string, wakeAt: number): void;
  now?(): number;
}

interface SleepEvent {
  loopRunId?: unknown;
  resumeAt?: unknown;
  willResume?: unknown;
}

export function registerLoopSleepContext(deps: LoopSleepDeps): void {
  for (const event of ['loop:cancelled', 'loop:failed', 'loop:completed', 'loop:completed-needs-review']) {
    deps.coordinator.on(event, payload => {
      const { loopRunId } = payload as SleepEvent;
      if (typeof loopRunId === 'string') getPreSleepContext()?.revokeClaim(`loop:${loopRunId}`);
    });
  }
  const handle = (loopRunId: string, resumeAt: number, quotaLimited: boolean): void => {
    const sleepMs = resumeAt - (deps.now?.() ?? Date.now());
    const adapter = deps.getPersistentAdapter(loopRunId);
    if (adapter && typeof adapter === 'object') {
      const claude = adapter as { getName?: () => string; getLastContextUsage?: () => ContextUsageObservation };
      if (claude.getName?.() !== 'claude-cli') return;
      const usage = claude.getLastContextUsage?.();
      const decision = decideSleepContext({
        sleepMs,
        contextTokens: usage?.status === 'known' ? usage.used : null,
        cacheLifetimeMs: getClaudeCacheLifetime(adapter)?.lifetimeMs,
        canCompact: false,
        canRecycle: true,
      });
      if (decision.action !== 'recycle') return;
      logger.info('Loop will sleep past its cache lifetime; its next iteration starts in a fresh session', {
        loopRunId,
        sleepMinutes: Math.round(sleepMs / 60_000),
        contextTokens: usage?.status === 'known' ? usage.used : undefined,
        quotaLimited,
      });
      deps.coordinator.requestContextReset?.(loopRunId);
      return;
    }
    // A provider-limit park cannot run a compaction; only a scheduled wake-up can.
    if (quotaLimited || !deps.isBorrowedChat(loopRunId)) return;
    const chatId = deps.coordinator.getLoop?.(loopRunId)?.chatId;
    if (!chatId) return;
    if (deps.noteChatSleep) deps.noteChatSleep(chatId, resumeAt);
    else void getPreSleepContext()?.note({ instanceId: chatId, wakeAt: resumeAt, source: 'loop-wakeup', claimKey: `loop:${loopRunId}` });
  };

  deps.coordinator.on('loop:wakeup-scheduled', (payload) => {
    const event = payload as SleepEvent;
    if (typeof event.loopRunId === 'string' && typeof event.resumeAt === 'number') handle(event.loopRunId, event.resumeAt, false);
  });
  deps.coordinator.on('loop:provider-limit', (payload) => {
    const event = payload as SleepEvent;
    if (event.willResume === true && typeof event.loopRunId === 'string' && typeof event.resumeAt === 'number') {
      handle(event.loopRunId, event.resumeAt, true);
    }
  });
}
