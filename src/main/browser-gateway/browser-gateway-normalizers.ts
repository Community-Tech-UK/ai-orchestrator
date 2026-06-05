import type {
  BrowserAccessibilityNode,
  BrowserEvaluateResult,
} from '@contracts/types/browser';
import { redactBrowserText } from './browser-redaction';

export function normalizeAccessibilityNodes(result: unknown, limit: number): BrowserAccessibilityNode[] {
  const raw = Array.isArray(result)
    ? result
    : result && typeof result === 'object'
      ? (result as Record<string, unknown>)['nodes']
      : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  const nodes: BrowserAccessibilityNode[] = [];
  for (const item of raw) {
    if (nodes.length >= limit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const uid = value['uid'];
    const role = value['role'];
    if (typeof uid !== 'string' || !uid || typeof role !== 'string' || !role) {
      continue;
    }
    const node: BrowserAccessibilityNode = { uid: uid.slice(0, 64), role: role.slice(0, 120) };
    if (typeof value['name'] === 'string' && value['name']) {
      node.name = redactBrowserText(value['name']).slice(0, 2000);
    }
    if (typeof value['value'] === 'string' && value['value']) {
      node.value = redactBrowserText(value['value']).slice(0, 2000);
    }
    if (typeof value['description'] === 'string' && value['description']) {
      node.description = redactBrowserText(value['description']).slice(0, 2000);
    }
    if (value['checked'] === 'mixed' || typeof value['checked'] === 'boolean') {
      node.checked = value['checked'] as boolean | 'mixed';
    }
    for (const key of ['selected', 'expanded', 'disabled', 'focused'] as const) {
      if (typeof value[key] === 'boolean') {
        node[key] = value[key] as boolean;
      }
    }
    if (typeof value['level'] === 'number') {
      node.level = value['level'];
    }
    nodes.push(node);
  }
  return nodes;
}

export function normalizeEvaluateResult(raw: unknown): BrowserEvaluateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const value = raw as Record<string, unknown>;
  const out: BrowserEvaluateResult = {};
  if (typeof value['type'] === 'string' && value['type']) {
    out.type = value['type'].slice(0, 60);
  }
  if (typeof value['json'] === 'string') {
    out.json = redactBrowserText(value['json']).slice(0, 20_000);
  }
  if (value['truncated'] === true) {
    out.truncated = true;
  }
  return out;
}
