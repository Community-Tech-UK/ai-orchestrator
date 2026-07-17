/**
 * Integration repro for the reliability-hardening acceptance criteria: a
 * multi-step SPA form flow interrupted by a worker-channel drop.
 *
 * Asserts: (a) the MCP tool surface is identical after a forwarder restart,
 * (b) writes into a stale session return errors — never `succeeded`,
 * (c) the write journal reports exactly which steps persisted, and
 * (d) additive unknown optional RPC fields degrade instead of hard-failing.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import { BrowserExtensionContactState } from './browser-extension-contact-state';
import { BrowserExtensionTabStore } from './browser-extension-tab-store';
import { createDeferredBrowserMcpTools } from './browser-mcp-deferral';
import { BrowserReliabilityEvents } from './browser-reliability-events';
import { validateBrowserRpcPayload } from './browser-rpc-server-support';
import { BrowserTargetPersistenceSentinel } from './browser-target-persistence-sentinel';
import { BrowserTargetRegistry } from './browser-target-registry';
import { BrowserToolRevealStore } from './browser-tool-reveal-store';
import { BrowserWriteJournal } from './browser-write-journal';
import { McpServer } from '../mcp/mcp-server';

type PageState = 'healthy' | 'disconnected_banner' | 'save_failing';

describe('browser-gateway reconnect-mid-flow reliability', () => {
  let journalDir: string;

  beforeEach(async () => {
    journalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-reliability-'));
    BrowserReliabilityEvents._resetForTesting();
    McpServer._resetForTesting();
  });

  afterEach(async () => {
    await fs.rm(journalDir, { recursive: true, force: true });
    McpServer._resetForTesting();
  });

  it('fails loud on a stale session, journals exactly what persisted, and resumes after recovery', async () => {
    let now = 10_000;
    let pageState: PageState = 'healthy';
    const events = new BrowserReliabilityEvents(() => now);
    const contactState = new BrowserExtensionContactState({ now: () => now });
    const registry = new BrowserTargetRegistry();
    const tabStore = new BrowserExtensionTabStore({
      targetRegistry: registry,
      reliabilityEvents: events,
      now: () => now,
    });
    const sentinel = new BrowserTargetPersistenceSentinel({ now: () => now });
    const journal = new BrowserWriteJournal({ rootDir: journalDir, now: () => now });

    // Fake extension: mutations succeed at the CDP level regardless of page
    // state (the silent-loss failure mode); the sentinel's evaluate sees the
    // page's own banners.
    const extensionSendCommand = vi.fn(async (request: { command: string }) => {
      if (request.command === 'evaluate') {
        if (pageState === 'disconnected_banner') {
          return { s: 'session_stale', m: 'you got disconnected' };
        }
        if (pageState === 'save_failing') {
          return { s: 'save_failed', m: 'changes failed to save' };
        }
        return { s: 'ok' };
      }
      return { ok: true };
    });

    const ops = new BrowserExistingTabOperations({
      extensionCommandStore: { sendCommand: extensionSendCommand as never },
      extensionTabStore: tabStore,
      isRemoteExtensionContactFresh: (nodeId) => contactState.isExtensionContactFresh(nodeId),
      describeRemoteExtensionContact: (nodeId) =>
        `${contactState.describeExtensionContact(nodeId).silent ? 'silent' : 'fresh'}`,
      grantStore: { listGrants: vi.fn(() => []), consumeGrant: vi.fn() },
      approvalStore: { createRequest: vi.fn() } as never,
      result: vi.fn((params) => params) as never,
      autoApproveApproval: () => null,
      persistenceSentinel: sentinel,
      writeJournal: journal,
      getLastChannelDisconnectAt: (nodeId) =>
        contactState.getLastDisconnect(nodeId ?? 'local')?.at,
      reliabilityEvents: events,
    });

    contactState.markExtensionContact('node-1', now);
    const attachment = tabStore.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://ads.google.com/campaigns/new',
      title: 'New campaign',
    }, { nodeId: 'node-1' });

    // Step 1 (healthy): the write lands and verifies.
    await ops.sendCommand(attachment, 'type', { selector: '#headline-1', value: 'Fast Local Service' });

    // Channel drop: node vanishes, app shows "You got disconnected".
    now += 5_000;
    contactState.markExtensionDisconnect('node-1', 'node_ws_disconnected');
    tabStore.suspendNode('node-1');
    pageState = 'disconnected_banner';

    // While the channel is down, writes fail fast at the freshness gate…
    now += 95_000; // contact goes stale
    await expect(ops.sendCommand(attachment, 'type', { selector: '#headline-2', value: 'Same-Day Quotes' }))
      .rejects.toThrow(/browser_extension_unreachable/);

    // …and after the channel returns, the FIRST write is gated on a session
    // check that sees the app's own disconnected banner: refused, not fired.
    contactState.markExtensionContact('node-1', now);
    tabStore.restoreNode('node-1');
    const survivor = tabStore.getTab(attachment.profileId, attachment.targetId);
    expect(survivor).not.toBeNull();
    expect(survivor!.suspendedAt).toBeUndefined();

    await expect(ops.sendCommand(survivor!, 'type', { selector: '#headline-2', value: 'Same-Day Quotes' }))
      .rejects.toThrow(/^browser_target_session_stale/);
    expect(extensionSendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'type', payload: expect.objectContaining({ selector: '#headline-2' }) }),
    );

    // The caller reloads the tab; the flow resumes — the pre-write session
    // check now passes and records the target as known-good.
    pageState = 'healthy';
    contactState.markExtensionContact('node-1', (now += 1_000));
    await ops.sendCommand(survivor!, 'type', { selector: '#headline-2', value: 'Same-Day Quotes' });

    // Later the app silently starts rejecting saves mid-flow (the observed
    // Google Ads failure): the CDP dispatch still succeeds, but the post-write
    // scan sees the app's own banner — surfaced as an error, never success.
    pageState = 'save_failing';
    await expect(ops.sendCommand(survivor!, 'type', { selector: '#headline-3', value: 'Free Site Visits' }))
      .rejects.toThrow(/^browser_target_save_rejected/);

    // Recovery again (reload); the step is re-entered deliberately.
    pageState = 'healthy';
    await ops.sendCommand(survivor!, 'type', { selector: '#headline-3', value: 'Free Site Visits' });

    // The journal reports exactly what persisted. The refused pre-write
    // attempt never fired, so it never became a journal intent.
    const entries = await journal.list(attachment.profileId, attachment.targetId);
    expect(entries.map((entry) => ({
      selector: entry.selector,
      outcome: entry.outcome,
      persistence: entry.persistence,
    }))).toEqual([
      { selector: '#headline-1', outcome: 'succeeded', persistence: 'ok' },
      { selector: '#headline-2', outcome: 'succeeded', persistence: 'ok' },
      { selector: '#headline-3', outcome: 'succeeded', persistence: 'save_failed' },
      { selector: '#headline-3', outcome: 'succeeded', persistence: 'ok' },
    ]);

    // Observability: the whole incident is visible as structured events.
    const kinds = events.recent().map((event) => event.kind);
    expect(kinds).toContain('attachment_suspended');
    expect(kinds).toContain('attachment_restored');
    expect(kinds).toContain('write_rejected_session_stale');
    expect(kinds).toContain('write_rejected_save_failed');
  });

  it('exposes the identical tool surface after a forwarder restart (deferral reveal restore)', async () => {
    const revealStore = new BrowserToolRevealStore();
    const client = { call: vi.fn(async () => null) };

    // Forwarder generation 1: deferral hides non-core tools; the session
    // reveals browser.evaluate; the parent records it.
    const serverA = McpServer.getInstance();
    serverA.registerTools(createDeferredBrowserMcpTools(client, {
      onReveal: (names) => {
        serverA.revealTools(names);
        revealStore.recordRevealed('instance-1', names);
      },
    }));
    const describeTool = serverA.getRegisteredTools()
      .find((tool) => tool.name === 'browser.tool_describe')!;
    await describeTool.handler({ name: 'browser.evaluate' });
    const surfaceBefore = (await serverA.handleRequest({ method: 'tools/list' }) as {
      tools: Array<{ name: string }>;
    }).tools.map((tool) => tool.name).sort();
    expect(surfaceBefore).toContain('browser.evaluate');

    // Forwarder restart (MCP reconnect): generation 2 restores the recorded
    // reveal state BEFORE its first tools/list.
    McpServer._resetForTesting();
    const serverB = McpServer.getInstance();
    serverB.registerTools(createDeferredBrowserMcpTools(client, {
      onReveal: (names) => serverB.revealTools(names),
    }));
    serverB.revealTools(revealStore.getRevealed('instance-1'));
    const surfaceAfter = (await serverB.handleRequest({ method: 'tools/list' }) as {
      tools: Array<{ name: string }>;
    }).tools.map((tool) => tool.name).sort();

    expect(surfaceAfter).toEqual(surfaceBefore);
  });

  it('never hard-fails an additive optional RPC field on version skew', () => {
    BrowserReliabilityEvents._resetForTesting();
    const payload = validateBrowserRpcPayload('browser.snapshot', {
      profileId: 'profile-1',
      targetId: 'target-1',
      extractionHint: 'campaign budget state',
      aFieldFromNextYear: { nested: true },
    });
    expect(payload).toEqual({
      profileId: 'profile-1',
      targetId: 'target-1',
      extractionHint: 'campaign budget state',
    });
  });
});
