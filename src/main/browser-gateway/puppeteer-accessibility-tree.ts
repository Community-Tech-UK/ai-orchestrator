import type { BrowserCdpSession } from './browser-download-watcher';

/** Frames walked per accessibility snapshot; mirrors the extension's cap. */
const MAX_ACCESSIBILITY_FRAMES = 25;

/**
 * One wall-clock ceiling for the complete snapshot: domain enables, frame
 * discovery, the mandatory main AX tree, and child AX trees. The frame cap
 * bounds call count; this deadline bounds unresolved or individually slow CDP
 * calls. The extension path carries the equivalent whole-snapshot budget.
 */
const ACCESSIBILITY_WALK_BUDGET_MS = 20_000;

/**
 * Guaranteed slice for the MAIN frame. Reading it is the original single-call
 * behaviour, previously bounded only by puppeteer's 180s protocolTimeout, so
 * leaving it whatever the control hops did not use (~5s of a 20s budget) would
 * fail large pages that used to succeed.
 *
 * The control hops are therefore clamped to `remaining - MIN_MAIN_FRAME_SLICE_MS`
 * so this floor is RESERVED rather than additive: without that clamp the real
 * worst case was 15s of control hops plus a 15s floor = 30s against a budget
 * documented as 20s, which is the fourth round this file's stated bound did not
 * match its behaviour.
 */
const MIN_MAIN_FRAME_SLICE_MS = 15_000;

const CDP_CONTROL_TIMEOUT_MS = 5_000;

/**
 * Collect the raw accessibility nodes from the main frame and reachable child
 * frames. A child-frame refusal is expected for some OOPIFs and is skipped;
 * failure of the main frame remains fatal so callers never mistake failure for
 * a confidently empty page.
 */
export async function collectAccessibilityTreeNodes(
  session: BrowserCdpSession,
  now: () => number = Date.now,
): Promise<unknown[]> {
  const deadlineAt = now() + ACCESSIBILITY_WALK_BUDGET_MS;
  const controlHopTimeout = (): number | null => {
    const available = Math.min(
      CDP_CONTROL_TIMEOUT_MS,
      deadlineAt - now() - MIN_MAIN_FRAME_SLICE_MS,
    );
    // Do not manufacture a per-hop floor once the reserved control budget is
    // gone. Additive floors let unresolved control calls run past the absolute
    // deadline before a fresh main-frame floor began.
    return available > 0 ? available : null;
  };
  // The enable hops live INSIDE the budget. Issued by the caller beforehand they
  // were unbounded (`BrowserCdpSession.send` takes no timeout and a `.catch()`
  // does not bound a hang), so the "wall-clock bound" bounded the walk but not
  // the snapshot -- worst case two 180s protocolTimeouts before the clock even
  // started. This is the same arming mistake the extension path had to fix twice.
  for (const domain of ['DOM.enable', 'Accessibility.enable']) {
    const timeoutMs = controlHopTimeout();
    if (timeoutMs === null) break;
    await sendWithDeadline(
      session,
      domain,
      {},
      timeoutMs,
    ).catch(() => undefined);
  }

  const frameIds: (string | undefined)[] = [undefined];
  try {
    const timeoutMs = controlHopTimeout();
    if (timeoutMs === null) throw new Error('browser_cdp_control_budget_exhausted');
    const frameTree = (await sendWithDeadline(
      session,
      'Page.getFrameTree',
      {},
      timeoutMs,
    )) as {
      frameTree?: { childFrames?: unknown[] };
    };
    const walk = (entry: { childFrames?: unknown[] } | undefined): void => {
      if (!entry || frameIds.length >= MAX_ACCESSIBILITY_FRAMES) return;
      for (const child of entry.childFrames ?? []) {
        const node = child as { frame?: { id?: string }; childFrames?: unknown[] };
        const id = node.frame?.id;
        if (typeof id === 'string' && id && !frameIds.includes(id)) frameIds.push(id);
        if (frameIds.length >= MAX_ACCESSIBILITY_FRAMES) return;
        walk(node);
      }
    };
    walk(frameTree.frameTree);
  } catch {
    // No frame tree means no reachable iframes; the main frame still works.
  }

  const merged: unknown[] = [];
  const seen = new Set<number>();
  for (const frameId of frameIds) {
    // The main frame is never skipped for time: returning a confidently EMPTY
    // tree is worse than being slow, because the caller cannot tell "no
    // controls" from "never looked".
    if (frameId !== undefined && now() >= deadlineAt) {
      break;
    }
    let tree: unknown;
    try {
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) {
        throw new Error('browser_cdp_timeout:Accessibility.getFullAXTree');
      }
      tree = await sendWithDeadline(
        session,
        'Accessibility.getFullAXTree',
        frameId === undefined ? {} : { frameId },
        Math.max(1, remainingMs),
      );
    } catch (error) {
      if (frameId === undefined) throw error;
      continue;
    }
    const raw = (tree as { nodes?: unknown[] })?.nodes;
    for (const node of Array.isArray(raw) ? raw : []) {
      const backendId = (node as { backendDOMNodeId?: unknown })?.backendDOMNodeId;
      if (typeof backendId !== 'number' || seen.has(backendId)) continue;
      seen.add(backendId);
      merged.push(node);
    }
  }
  return merged;
}

async function sendWithDeadline(
  session: BrowserCdpSession,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser_cdp_timeout:${method}`)),
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([session.send(method, params), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
