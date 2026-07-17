/**
 * Service-level implementations of the reliability MCP tools
 * (`browser.assert_persisted`, `browser.write_journal`), kept out of the main
 * BrowserGatewayService body. The service exposes thin delegating methods.
 */

import type {
  BrowserAssertPersistedRequest,
  BrowserGatewayResult,
  BrowserWriteJournalRequest,
} from '@contracts/types/browser';
import {
  runAssertPersisted,
  type BrowserAssertPersistedData,
} from './browser-assert-persisted-operation';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserExtensionSendCommandRequest } from './browser-extension-command-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import { isOriginAllowed } from './browser-origin-policy';
import type {
  BrowserTargetPersistenceScan,
  BrowserTargetPersistenceSentinel,
} from './browser-target-persistence-sentinel';
import type { BrowserWriteJournal, BrowserWriteJournalEntry } from './browser-write-journal';

export interface BrowserReliabilityOperationDeps {
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  getTab: (profileId: string, targetId: string) => BrowserExistingTabAttachment | null;
  persistenceSentinel: Pick<BrowserTargetPersistenceSentinel, 'scan'> | null | undefined;
  writeJournal: Pick<BrowserWriteJournal, 'list'> | null | undefined;
  sendExtensionCommand: (request: BrowserExtensionSendCommandRequest) => Promise<unknown>;
  readControlForTarget: (
    profileId: string,
    targetId: string,
    selector: string,
  ) => Promise<{ value?: string; selectedLabel?: string; checked?: boolean }>;
}

/**
 * `browser.assert_persisted`: app failure-signal scan + optional control
 * read-backs → a plain persisted/not-persisted verdict for long stateful
 * flows. Read-class; never mutates the page.
 */
export async function assertPersistedOperation(
  deps: BrowserReliabilityOperationDeps,
  request: BrowserGatewayContext & BrowserAssertPersistedRequest,
): Promise<BrowserGatewayResult<BrowserAssertPersistedData | null>> {
  const existingTab = deps.getTab(request.profileId, request.targetId);
  if (existingTab) {
    const originDecision = isOriginAllowed(existingTab.url, existingTab.allowedOrigins);
    if (!originDecision.allowed) {
      return deps.result({
        context: request,
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        action: 'assert_persisted',
        toolName: 'browser.assert_persisted',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Persistence assertion denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: existingTab.url,
        data: null,
      });
    }
  }
  const sentinel = deps.persistenceSentinel;
  const scan = existingTab && sentinel
    ? () => sentinel.scan(existingTab, deps.sendExtensionCommand)
    : async (): Promise<BrowserTargetPersistenceScan> =>
      ({ state: 'unknown', checkedAt: Date.now() });
  try {
    const data = await runAssertPersisted({
      scan,
      readControl: (selector) =>
        deps.readControlForTarget(request.profileId, request.targetId, selector),
    }, request.expectations ?? []);
    return deps.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'assert_persisted',
      toolName: 'browser.assert_persisted',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: data.persisted
        ? `Target state persisted (${data.confidence}: signal=${data.signalState}, ${data.checkedExpectations} read-backs)`
        : `Target state NOT persisted (signal=${data.signalState}, ${data.mismatches.length} read-back mismatches)`,
      ...(existingTab ? { origin: existingTab.origin, url: existingTab.url } : {}),
      data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deps.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'assert_persisted',
      toolName: 'browser.assert_persisted',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'failed',
      reason: message,
      summary: `Persistence assertion failed: ${message}`,
      data: null,
    });
  }
}

/** `browser.write_journal`: recent journaled mutations for one target. */
export async function writeJournalListOperation(
  deps: Pick<BrowserReliabilityOperationDeps, 'result' | 'writeJournal'>,
  request: BrowserGatewayContext & BrowserWriteJournalRequest,
): Promise<BrowserGatewayResult<BrowserWriteJournalEntry[] | null>> {
  if (!deps.writeJournal) {
    return deps.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'write_journal',
      toolName: 'browser.write_journal',
      actionClass: 'read',
      decision: 'denied',
      outcome: 'not_run',
      reason: 'browser_write_journal_unavailable',
      summary: 'Browser write journal is not enabled in this gateway',
      data: null,
    });
  }
  const entries = await deps.writeJournal.list(
    request.profileId,
    request.targetId,
    request.limit ?? 50,
  );
  return deps.result({
    context: request,
    profileId: request.profileId,
    targetId: request.targetId,
    action: 'write_journal',
    toolName: 'browser.write_journal',
    actionClass: 'read',
    decision: 'allowed',
    outcome: 'succeeded',
    summary: `Read ${entries.length} write-journal entries for target`,
    data: entries,
  });
}
