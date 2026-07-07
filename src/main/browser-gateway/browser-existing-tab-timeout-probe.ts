import type { BrowserControlVerifyExpectation } from '@contracts/types/browser';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type {
  BrowserExtensionCommandName,
  BrowserExtensionSendCommandRequest,
} from './browser-extension-command-store';
import { browserExtensionQueueKeyForNode } from './browser-extension-command-store';
import { extractTabPayload } from './browser-gateway-service-helpers';
import { verifyControlExpectation } from './browser-mutation-verify';
import { selectionMatches } from './browser-select-resolver';

const POST_TIMEOUT_PROBE_TIMEOUT_MS = 8_000;
const POST_TIMEOUT_PROBE_EXECUTION_MS = 6_000;

type TimeoutMutationProbeStatus = 'timed_out_applied' | 'timed_out_not_applied' | 'unknown';

interface TimeoutMutationProbe {
  selector: string;
  expected: BrowserControlVerifyExpectation;
  selectDesired?: string;
}

interface ControlReadback {
  value?: string;
  selectedLabel?: string;
  checked?: boolean;
}

export async function postTimeoutMutationProbe(
  command: BrowserExtensionCommandName,
  payload: Record<string, unknown> | undefined,
  attachment: BrowserExistingTabAttachment,
  sendCommand: (request: BrowserExtensionSendCommandRequest) => Promise<unknown>,
): Promise<string> {
  const probes = timeoutMutationProbes(command, payload);
  if (probes.length > 0) {
    const status = await readTimeoutMutationStatus(attachment, probes, sendCommand);
    if (status !== 'unknown') {
      return status;
    }
  }
  return `unknown${await postTimeoutSnapshotSuffix(attachment, sendCommand)}`;
}

async function readTimeoutMutationStatus(
  attachment: BrowserExistingTabAttachment,
  probes: TimeoutMutationProbe[],
  sendCommand: (request: BrowserExtensionSendCommandRequest) => Promise<unknown>,
): Promise<TimeoutMutationProbeStatus> {
  try {
    let matched = 0;
    for (const probe of probes) {
      const readback = normalizeControlReadback(await sendCommand({
        ...(attachment.nodeId ? { queueKey: browserExtensionQueueKeyForNode(attachment.nodeId) } : {}),
        command: 'read_control',
        target: {
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          tabId: attachment.tabId,
          windowId: attachment.windowId,
        },
        payload: { selector: probe.selector },
        timeoutMs: POST_TIMEOUT_PROBE_TIMEOUT_MS,
        executionTimeoutMs: POST_TIMEOUT_PROBE_EXECUTION_MS,
        undeliveredWaitMs: POST_TIMEOUT_PROBE_TIMEOUT_MS,
      }));
      if (!readback) {
        return 'timed_out_not_applied';
      }
      const mismatch = probe.selectDesired !== undefined
        ? (selectionMatches(readback, probe.selectDesired) ? null : 'browser_verify_mismatch:value,selectedLabel')
        : verifyControlExpectation(probe.expected, readback);
      if (mismatch) {
        return 'timed_out_not_applied';
      }
      matched += 1;
    }
    return matched > 0 ? 'timed_out_applied' : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function postTimeoutSnapshotSuffix(
  attachment: BrowserExistingTabAttachment,
  sendCommand: (request: BrowserExtensionSendCommandRequest) => Promise<unknown>,
): Promise<string> {
  try {
    const result = await sendCommand({
      ...(attachment.nodeId ? { queueKey: browserExtensionQueueKeyForNode(attachment.nodeId) } : {}),
      command: 'snapshot',
      target: {
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        tabId: attachment.tabId,
        windowId: attachment.windowId,
      },
      timeoutMs: POST_TIMEOUT_PROBE_TIMEOUT_MS,
      executionTimeoutMs: POST_TIMEOUT_PROBE_EXECUTION_MS,
      undeliveredWaitMs: POST_TIMEOUT_PROBE_TIMEOUT_MS,
    });
    const tab = extractTabPayload(result);
    return ` (post-timeout probe: page is now at ${tab.url}${tab.title ? ` - "${tab.title}"` : ''})`;
  } catch {
    return '';
  }
}

function timeoutMutationProbes(
  command: BrowserExtensionCommandName,
  payload: Record<string, unknown> | undefined,
): TimeoutMutationProbe[] {
  if (!payload) {
    return [];
  }
  const verifyProbe = timeoutVerifyProbe(payload, payload['verify']);
  if (verifyProbe) {
    return [verifyProbe];
  }
  if (command === 'click') {
    return [];
  }
  if (command === 'type') {
    const selector = payload['selector'];
    const value = payload['value'];
    return typeof selector === 'string' && typeof value === 'string'
      ? [{ selector, expected: { value } }]
      : [];
  }
  if (command === 'select') {
    const selector = payload['selector'];
    const value = payload['value'];
    return typeof selector === 'string' && typeof value === 'string'
      ? [{ selector, expected: { value }, selectDesired: value }]
      : [];
  }
  if (command === 'fill_form') {
    const fields = payload['fields'];
    if (!Array.isArray(fields)) {
      return [];
    }
    return fields.flatMap((field): TimeoutMutationProbe[] => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        return [];
      }
      const record = field as Record<string, unknown>;
      const selector = record['selector'];
      const verify = record['verify'];
      const value = record['value'];
      if (typeof selector !== 'string') {
        return [];
      }
      if (isVerifyExpectation(verify)) {
        return [{ selector, expected: verify }];
      }
      return typeof value === 'string'
        ? [{ selector, expected: { value } }]
        : [];
    });
  }
  return [];
}

function timeoutVerifyProbe(
  payload: Record<string, unknown>,
  verify: unknown,
): TimeoutMutationProbe | null {
  if (!isVerifyExpectation(verify)) {
    return null;
  }
  const payloadSelector = payload['selector'];
  const selector = typeof verify.selector === 'string'
    ? verify.selector
    : (typeof payloadSelector === 'string' ? payloadSelector : undefined);
  return selector ? { selector, expected: verify } : null;
}

function normalizeControlReadback(value: unknown): ControlReadback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record['__found'] === false) {
    return null;
  }
  return {
    ...(typeof record['value'] === 'string' ? { value: record['value'] } : {}),
    ...(typeof record['selectedLabel'] === 'string' ? { selectedLabel: record['selectedLabel'] } : {}),
    ...(typeof record['checked'] === 'boolean' ? { checked: record['checked'] } : {}),
  };
}

function isVerifyExpectation(value: unknown): value is BrowserControlVerifyExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['value'] === 'string' ||
    typeof record['selectedLabel'] === 'string' ||
    typeof record['checked'] === 'boolean'
  );
}
