import * as crypto from 'node:crypto';
import type {
  DesktopAccessibilityNode,
  DesktopElementCandidate,
  DesktopPoint,
  DesktopQueryElementsRequest,
} from '../../shared/types/desktop-gateway.types';

const OBSERVATION_TOKEN_TTL_MS = 15_000;

export interface ObservationRecord {
  appId: string;
  windowId?: string;
  capturedAt: number;
  contentHash: string;
  expiresAt: number;
  snapshot?: DesktopAccessibilityNode[];
}

export interface ObservationTokenMeta {
  windowId?: string;
  contentHash?: string;
  snapshot?: DesktopAccessibilityNode[];
}

export type ObservationQueryResult =
  | { ok: true; appId: string; candidates: DesktopElementCandidate[] }
  | { ok: false; reason: string };

export type ObservationElementResult =
  | { ok: true; appId: string; candidate: DesktopElementCandidate }
  | { ok: false; reason: string };

/**
 * Time-bounded, single-app observation tokens minted by screenshot and
 * accessibility-snapshot calls and required by every input action. Hardened
 * with the captured window id, capture time, and a content hash so a stale or
 * cross-app token is rejected. Extracted from the gateway service to keep that
 * file within the size ratchet and to make token behavior independently
 * testable.
 */
export class DesktopObservationStore {
  private readonly tokens = new Map<string, ObservationRecord>();

  constructor(
    private readonly now: () => number,
    private readonly mintId: () => string,
  ) {}

  create(appId: string, meta: ObservationTokenMeta = {}): string {
    const token = `obs_${this.mintId()}`;
    this.tokens.set(token, {
      appId,
      ...(meta.windowId ? { windowId: meta.windowId } : {}),
      capturedAt: this.now(),
      contentHash: meta.contentHash ?? '',
      expiresAt: this.now() + OBSERVATION_TOKEN_TTL_MS,
      ...(meta.snapshot ? { snapshot: meta.snapshot } : {}),
    });
    return token;
  }

  /** Returns an error code when the token is stale/expired or app-mismatched. */
  validate(token: string, appId: string, currentWindowId?: string): string | null {
    const observation = this.tokens.get(token);
    if (!observation || observation.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return 'computer_use_stale_observation';
    }
    if (observation.appId !== appId) {
      return 'computer_use_stale_observation';
    }
    if (observation.windowId && observation.windowId !== currentWindowId) {
      return 'computer_use_target_changed';
    }
    return null;
  }

  getWindowId(token: string, appId: string): string | undefined {
    const observation = this.tokens.get(token);
    return observation?.appId === appId && observation.expiresAt > this.now()
      ? observation.windowId
      : undefined;
  }

  query(request: DesktopQueryElementsRequest): ObservationQueryResult {
    const observation = this.tokens.get(request.observationToken);
    if (!observation || observation.expiresAt <= this.now()) {
      this.tokens.delete(request.observationToken);
      return { ok: false, reason: 'computer_use_stale_observation' };
    }
    if (request.appId && observation.appId !== request.appId) {
      return { ok: false, reason: 'computer_use_stale_observation' };
    }
    if (!observation.snapshot) {
      return { ok: false, reason: 'computer_use_no_snapshot' };
    }
    const limit = request.limit ?? 25;
    return {
      ok: true,
      appId: observation.appId,
      candidates: matchElements(observation.snapshot, request, limit),
    };
  }

  findElement(token: string, appId: string, uid: string): ObservationElementResult {
    const observation = this.tokens.get(token);
    if (!observation || observation.expiresAt <= this.now() || observation.appId !== appId) {
      this.tokens.delete(token);
      return { ok: false, reason: 'computer_use_stale_observation' };
    }
    if (!observation.snapshot) {
      return { ok: false, reason: 'computer_use_no_snapshot' };
    }
    const node = findNodeByUid(observation.snapshot, uid);
    return node
      ? { ok: true, appId: observation.appId, candidate: toCandidate(node) }
      : { ok: false, reason: 'computer_use_element_not_found' };
  }

  findFocusedElement(token: string, appId: string): ObservationElementResult {
    const observation = this.tokens.get(token);
    if (!observation || observation.expiresAt <= this.now() || observation.appId !== appId) {
      this.tokens.delete(token);
      return { ok: false, reason: 'computer_use_stale_observation' };
    }
    if (!observation.snapshot) {
      return { ok: false, reason: 'computer_use_no_snapshot' };
    }
    const node = findFocusedNode(observation.snapshot);
    return node
      ? { ok: true, appId: observation.appId, candidate: toCandidate(node) }
      : { ok: false, reason: 'computer_use_focused_element_unavailable' };
  }

  findElementAtPoint(
    token: string,
    appId: string,
    point: DesktopPoint,
  ): ObservationElementResult {
    const observation = this.tokens.get(token);
    if (!observation || observation.expiresAt <= this.now() || observation.appId !== appId) {
      this.tokens.delete(token);
      return { ok: false, reason: 'computer_use_stale_observation' };
    }
    if (!observation.snapshot) {
      return { ok: false, reason: 'computer_use_no_snapshot' };
    }
    const node = findNodeAtPoint(observation.snapshot, point);
    return node
      ? { ok: true, appId: observation.appId, candidate: toCandidate(node) }
      : { ok: false, reason: 'computer_use_target_outside_approved_window' };
  }

  static hashContent(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  }
}

function matchElements(
  nodes: DesktopAccessibilityNode[],
  query: DesktopQueryElementsRequest,
  limit: number,
): DesktopElementCandidate[] {
  const out: DesktopElementCandidate[] = [];
  const visit = (node: DesktopAccessibilityNode): void => {
    if (out.length >= limit) {
      return;
    }
    if (elementMatchesQuery(node, query)) {
      out.push(toCandidate(node));
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return out;
}

function findNodeByUid(
  nodes: DesktopAccessibilityNode[],
  uid: string,
): DesktopAccessibilityNode | null {
  for (const node of nodes) {
    if (node.uid === uid) {
      return node;
    }
    const child = findNodeByUid(node.children ?? [], uid);
    if (child) {
      return child;
    }
  }
  return null;
}

function findFocusedNode(nodes: DesktopAccessibilityNode[]): DesktopAccessibilityNode | null {
  for (const node of nodes) {
    if (node.focused) {
      return node;
    }
    const child = findFocusedNode(node.children ?? []);
    if (child) {
      return child;
    }
  }
  return null;
}

function findNodeAtPoint(
  nodes: DesktopAccessibilityNode[],
  point: DesktopPoint,
): DesktopAccessibilityNode | null {
  let best: DesktopAccessibilityNode | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  const visit = (node: DesktopAccessibilityNode): void => {
    const bounds = node.bounds;
    if (bounds
      && point.x >= bounds.x
      && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y
      && point.y <= bounds.y + bounds.height) {
      const area = bounds.width * bounds.height;
      if (area <= bestArea) {
        best = node;
        bestArea = area;
      }
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return best;
}

function toCandidate(node: DesktopAccessibilityNode): DesktopElementCandidate {
  return {
    uid: node.uid,
    role: node.role,
    ...(node.label ? { label: node.label } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.url ? { url: node.url } : {}),
    ...(node.bounds ? { bounds: node.bounds } : {}),
    ...(node.enabled !== undefined ? { enabled: node.enabled } : {}),
    ...(node.focused !== undefined ? { focused: node.focused } : {}),
    ...(node.redacted !== undefined ? { redacted: node.redacted } : {}),
  };
}

function elementMatchesQuery(
  node: DesktopAccessibilityNode,
  query: DesktopQueryElementsRequest,
): boolean {
  const hasFilter = Boolean(query.text || query.role || query.label || query.value);
  if (!hasFilter) {
    return true;
  }
  if (query.role && node.role !== query.role) {
    return false;
  }
  if (query.label && !(node.label ?? '').toLowerCase().includes(query.label.toLowerCase())) {
    return false;
  }
  if (query.value && !(node.value ?? '').toLowerCase().includes(query.value.toLowerCase())) {
    return false;
  }
  if (query.text) {
    const haystack = [node.label, node.value, node.role].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(query.text.toLowerCase())) {
      return false;
    }
  }
  return true;
}
