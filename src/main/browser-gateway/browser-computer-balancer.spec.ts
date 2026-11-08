import type { BrowserTarget } from '@contracts/types/browser';
import { describe, expect, it } from 'vitest';
import type { ComputerChoice } from '../../shared/types/settings.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { BROWSER_SESSION_IDLE_MS, BrowserComputerBalancer, browserComputers, originOf } from './browser-computer-balancer';

const node = (id: string, platform: WorkerNodeInfo['capabilities']['platform'], hasBrowserMcp = true): WorkerNodeInfo => ({
  id, name: id, status: 'connected', activeInstances: 0,
  capabilities: {
    platform, arch: 'arm64', cpuCores: 8, totalMemoryMB: 1, availableMemoryMB: 1, supportedClis: [], hasBrowserRuntime: true,
    hasBrowserMcp, hasAndroidMcp: false, hasDocker: false, maxConcurrentInstances: 4, workingDirectories: [], browsableRoots: [],
    discoveredProjects: [],
  },
});
const tab = (nodeId: string, origin: string, stale = false): BrowserTarget => ({
  id: `${nodeId}-${origin}`, nodeId, origin, mode: 'existing-tab', driver: 'extension', status: 'available', lastSeenAt: 1,
  ...(stale ? { stale } : {}),
});

const PC = node('pc', 'win32');
const MAC = node('mac', 'darwin');

function chooser(options: { nodes?: WorkerNodeInfo[]; choices?: ComputerChoice[]; targets?: BrowserTarget[] } = {}) {
  const balancer = new BrowserComputerBalancer();
  const choose = (instanceId: string, now = 0, url?: string) => balancer.choose({
    instanceId, nodes: options.nodes ?? [PC, MAC], choices: options.choices ?? [], targets: options.targets ?? [],
    origin: originOf(url), now,
  })?.id;
  return { balancer, choose };
}

describe('choosing a browser computer', () => {
  it('starts on Windows when nothing else decides, as before there were several', () => {
    expect(chooser().choose('a')).toBe('pc');
  });

  it('follows the Computers page order when the computers are equally used', () => {
    const { choose } = chooser({ choices: [{ id: 'mac', paused: false, sessions: true }, { id: 'pc', paused: false, sessions: true }] });
    expect(choose('a')).toBe('mac');
    expect(choose('b')).toBe('pc');
  });

  it('sends a new session to the computer the fewest sessions are using', () => {
    const { choose } = chooser();
    expect([choose('a'), choose('b'), choose('c'), choose('d')]).toEqual(['pc', 'mac', 'pc', 'mac']);
  });

  it('sends a new session where a tab on the same website is open, ignoring a stale one', () => {
    expect(chooser({ targets: [tab('mac', 'https://shop.test')] }).choose('a', 0, 'https://shop.test/basket')).toBe('mac');
    expect(chooser({ targets: [tab('mac', 'https://shop.test', true)] }).choose('a', 0, 'https://shop.test/')).toBe('pc');
    expect(chooser({ targets: [tab('mac', 'https://shop.test')] }).choose('a', 0, 'https://other.test/')).toBe('pc');
  });

  it('keeps a session where it is, until it has been idle for the limit', () => {
    const { choose } = chooser({ targets: [tab('pc', 'https://shop.test')] });
    expect(choose('a', 0, 'https://elsewhere.test')).toBe('pc');
    expect(choose('b', 0)).toBe('mac');
    expect(choose('b', 1000, 'https://shop.test')).toBe('mac');
    expect(choose('b', 1000 + BROWSER_SESSION_IDLE_MS, 'https://shop.test')).toBe('pc');
  });

  it('stops counting an idle session against its computer', () => {
    const { choose } = chooser();
    expect(choose('a', 0)).toBe('pc');
    expect(choose('b', BROWSER_SESSION_IDLE_MS)).toBe('pc');
  });

  it('moves a session whose computer can no longer take browser work', () => {
    const { balancer, choose } = chooser();
    balancer.noteUse('a', 'gone', 0);
    expect(choose('a', 1)).toBe('pc');
  });

  it('sends no new session to a paused computer, but keeps one already using it', () => {
    const pausedMac = [{ id: 'mac', paused: true, sessions: true }];
    const { balancer, choose } = chooser({ choices: pausedMac });
    balancer.noteUse('a', 'mac', 0);
    expect(choose('a', 1)).toBe('mac');
    expect(choose('b', 1)).toBe('pc');
    expect(choose('c', 1)).toBe('pc');
  });

  it('chooses none when no computer can take browser work', () => {
    expect(chooser({ nodes: [node('pc', 'win32', false)] }).choose('a')).toBeUndefined();
    expect(chooser({ nodes: [PC], choices: [{ id: 'pc', paused: true, sessions: true }] }).choose('a')).toBeUndefined();
  });
});

describe('browser computers and websites', () => {
  it('leaves out computers without browser automation', () => {
    expect(browserComputers([PC, MAC, node('bare', 'linux', false)]).map(entry => entry.id)).toEqual(['pc', 'mac']);
  });

  it('reads a website from a URL, and none from anything else', () => {
    expect(originOf('https://shop.test/basket?x=1')).toBe('https://shop.test');
    expect(originOf('about:blank')).toBeUndefined();
    expect(originOf('not a url')).toBeUndefined();
    expect(originOf(42)).toBeUndefined();
  });
});
