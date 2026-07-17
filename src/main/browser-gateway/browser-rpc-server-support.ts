/**
 * Support logic for the Browser Gateway RPC server (reliability hardening,
 * 2026-07-17): per-method payload validation with forward-compatible
 * unknown-key stripping, and the forwarder tool-surface continuity handlers.
 *
 * Main-process only (imports contracts schemas + reliability events).
 */

import {
  BrowserAccessibilitySnapshotRequestSchema,
  BrowserApprovalStatusRequestSchema,
  BrowserAssertPersistedRequestSchema,
  BrowserWriteJournalRequestSchema,
  BrowserClickRequestSchema,
  BrowserEvaluateRequestSchema,
  BrowserCreateProfileRequestSchema,
  BrowserDownloadFileRequestSchema,
  BrowserFindOrOpenRequestSchema,
  BrowserFillFormRequestSchema,
  BrowserListAuditLogRequestSchema,
  BrowserListGrantsRequestSchema,
  BrowserListTargetsRequestSchema,
  BrowserManualStepRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserProfileRequestSchema,
  BrowserQueryElementsRequestSchema,
  BrowserRequestGrantRequestSchema,
  BrowserRequestUserLoginRequestSchema,
  BrowserRevokeGrantRequestSchema,
  BrowserScreenshotRequestSchema,
  BrowserSelectRequestSchema,
  BrowserSnapshotRequestSchema,
  BrowserWorkflowCheckpointResumeRequestSchema,
  BrowserWorkflowCheckpointSaveRequestSchema,
  BrowserExecuteFillPlanRequestSchema,
  BrowserFillCredentialRequestSchema,
  BrowserFillSecretRequestSchema,
  BrowserCreateAgentCredentialRequestSchema,
  BrowserTargetRequestSchema,
  BrowserTypeRequestSchema,
  BrowserUploadFileRequestSchema,
  BrowserWaitForRequestSchema,
} from '@contracts/schemas/browser';
import type { ZodIssue, ZodType } from 'zod';
import { createBrowserMcpTools } from './browser-mcp-tools';
import { getBrowserReliabilityEvents } from './browser-reliability-events';
import {
  BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
  computeBrowserToolSurfaceHash,
} from './browser-rpc-contract';
import {
  computeBrowserToolSurfaceParity,
  type BrowserToolRevealStore,
} from './browser-tool-reveal-store';

const INVALID_PAYLOAD = 'Invalid browser gateway RPC payload';

/**
 * Methods excluded from unknown-key stripping. Dropping an unknown field here
 * could weaken a security constraint the caller intended (grants, credential
 * and secret fill, fill-plan verification, file movement) or silently discard
 * data the caller meant to persist (checkpoints). Additive evolution on these
 * methods requires updating both sides in lockstep.
 */
const STRICT_NO_STRIP_METHODS: ReadonlySet<string> = new Set([
  'browser.request_grant',
  'browser.revoke_grant',
  'browser.fill_credential',
  'browser.fill_secret',
  'browser.create_agent_credential',
  'browser.execute_fill_plan',
  'browser.upload_file',
  'browser.download_file',
  'browser.request_user_login',
  'browser.pause_for_manual_step',
  'browser.checkpoint_save',
  'browser.checkpoint_resume',
]);

function schemaForBrowserRpcMethod(method: string): ZodType | null {
  switch (method) {
    case 'browser.create_profile':
      return BrowserCreateProfileRequestSchema;
    case 'browser.find_or_open':
      return BrowserFindOrOpenRequestSchema;
    case 'browser.navigate':
      return BrowserNavigateRequestSchema;
    case 'browser.click':
      return BrowserClickRequestSchema;
    case 'browser.type':
      return BrowserTypeRequestSchema;
    case 'browser.fill_form':
      return BrowserFillFormRequestSchema;
    case 'browser.select':
      return BrowserSelectRequestSchema;
    case 'browser.execute_fill_plan':
      return BrowserExecuteFillPlanRequestSchema;
    case 'browser.fill_credential':
      return BrowserFillCredentialRequestSchema;
    case 'browser.fill_secret':
      return BrowserFillSecretRequestSchema;
    case 'browser.create_agent_credential':
      return BrowserCreateAgentCredentialRequestSchema;
    case 'browser.upload_file':
      return BrowserUploadFileRequestSchema;
    case 'browser.download_file':
      return BrowserDownloadFileRequestSchema;
    case 'browser.request_user_login':
      return BrowserRequestUserLoginRequestSchema;
    case 'browser.pause_for_manual_step':
      return BrowserManualStepRequestSchema;
    case 'browser.request_grant':
      return BrowserRequestGrantRequestSchema;
    case 'browser.get_approval_status':
      return BrowserApprovalStatusRequestSchema;
    case 'browser.list_grants':
      return BrowserListGrantsRequestSchema.optional().default({});
    case 'browser.revoke_grant':
      return BrowserRevokeGrantRequestSchema;
    case 'browser.screenshot':
      return BrowserScreenshotRequestSchema;
    case 'browser.open_profile':
    case 'browser.close_profile':
      return BrowserProfileRequestSchema;
    case 'browser.list_targets':
      return BrowserListTargetsRequestSchema;
    case 'browser.snapshot':
      return BrowserSnapshotRequestSchema;
    case 'browser.assert_persisted':
      return BrowserAssertPersistedRequestSchema;
    case 'browser.write_journal':
      return BrowserWriteJournalRequestSchema;
    case 'browser.select_target':
    case 'browser.console_messages':
    case 'browser.network_requests':
      return BrowserTargetRequestSchema;
    case 'browser.accessibility_snapshot':
      return BrowserAccessibilitySnapshotRequestSchema;
    case 'browser.evaluate':
      return BrowserEvaluateRequestSchema;
    case 'browser.wait_for':
      return BrowserWaitForRequestSchema;
    case 'browser.query_elements':
      return BrowserQueryElementsRequestSchema;
    case 'browser.get_audit_log':
      return BrowserListAuditLogRequestSchema;
    case 'browser.checkpoint_save':
      return BrowserWorkflowCheckpointSaveRequestSchema;
    case 'browser.checkpoint_resume':
      return BrowserWorkflowCheckpointResumeRequestSchema;
    default:
      return null;
  }
}

/**
 * Validate a payload against the method's request schema.
 *
 * Forward-compat: a newer bridge may send additive optional fields this build
 * does not know yet. When EVERY issue is an unrecognized-keys issue, strip
 * those keys, re-validate, and record the skew instead of hard-failing with
 * `invalid_browser_gateway_rpc_payload`. Type errors on known fields still
 * reject, and STRICT_NO_STRIP_METHODS stay fully strict.
 */
export function validateBrowserRpcPayload(
  method: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const schema = schemaForBrowserRpcMethod(method);
  if (!schema) {
    return payload;
  }
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data as Record<string, unknown>;
  }
  if (!STRICT_NO_STRIP_METHODS.has(method)) {
    const stripped = stripUnrecognizedKeys(payload, result.error.issues);
    if (stripped) {
      const retry = schema.safeParse(stripped.payload);
      if (retry.success) {
        getBrowserReliabilityEvents().record('schema_skew_stripped', {
          detail: { method, droppedKeys: stripped.droppedKeys },
        });
        return retry.data as Record<string, unknown>;
      }
    }
  }
  throw new Error(INVALID_PAYLOAD);
}

/**
 * Remove the keys named by `unrecognized_keys` issues (at their issue paths)
 * from a deep-cloned payload. Returns null when any issue is NOT an
 * unrecognized-keys issue — those payloads must keep hard-failing.
 */
function stripUnrecognizedKeys(
  payload: Record<string, unknown>,
  issues: readonly ZodIssue[],
): { payload: Record<string, unknown>; droppedKeys: string[] } | null {
  if (issues.length === 0) {
    return null;
  }
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const droppedKeys: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') {
      return null;
    }
    let cursor: unknown = clone;
    for (const segment of issue.path) {
      if (cursor === null || typeof cursor !== 'object') {
        return null;
      }
      cursor = (cursor as Record<PropertyKey, unknown>)[segment as PropertyKey];
    }
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return null;
    }
    for (const key of issue.keys) {
      delete (cursor as Record<string, unknown>)[key];
      droppedKeys.push(issue.path.length > 0 ? `${issue.path.join('.')}.${key}` : key);
    }
  }
  return { payload: clone, droppedKeys };
}

const MAX_TOOL_NAMES = 200;
const MAX_TOOL_NAME_LENGTH = 200;

export function parseBoundedNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(INVALID_PAYLOAD);
  }
  const names = value.slice(0, MAX_TOOL_NAMES);
  for (const name of names) {
    if (typeof name !== 'string' || !name || name.length > MAX_TOOL_NAME_LENGTH) {
      throw new Error(INVALID_PAYLOAD);
    }
  }
  return names as string[];
}

let cachedExpectedToolSurface: { names: string[]; surfaceHash: string } | null = null;

/**
 * The tool surface THIS build expects a forwarder to expose: the full browser
 * tool set (hidden-but-dispatchable tools included). Computed once — the tool
 * list is static per build.
 */
export function expectedBrowserToolSurface(): { names: string[]; surfaceHash: string } {
  if (!cachedExpectedToolSurface) {
    const tools = createBrowserMcpTools({ call: async () => null });
    cachedExpectedToolSurface = {
      names: tools.map((tool) => tool.name),
      surfaceHash: computeBrowserToolSurfaceHash(tools),
    };
  }
  return cachedExpectedToolSurface;
}

/**
 * Handle `browser.report_tool_surface`: record the forwarder's surface, check
 * parity + contract version against this build, and emit reliability events
 * on divergence.
 */
export function handleReportToolSurface(
  store: BrowserToolRevealStore,
  instanceId: string,
  payload: Record<string, unknown>,
): unknown {
  const protocolVersion = payload['protocolVersion'];
  const surfaceHash = payload['surfaceHash'];
  if (
    typeof protocolVersion !== 'number'
    || !Number.isInteger(protocolVersion)
    || typeof surfaceHash !== 'string'
    || surfaceHash.length === 0
    || surfaceHash.length > 64
  ) {
    throw new Error(INVALID_PAYLOAD);
  }
  const surface = {
    names: parseBoundedNameList(payload['names']),
    revealedNames: parseBoundedNameList(payload['revealedNames']),
    protocolVersion,
    surfaceHash,
    reportedAt: Date.now(),
  };
  store.recordSurface(instanceId, surface);
  const expected = expectedBrowserToolSurface();
  const parity = computeBrowserToolSurfaceParity({
    reported: surface,
    expectedNames: expected.names,
    expectedSurfaceHash: expected.surfaceHash,
    expectedProtocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
  });
  if (!parity.protocolVersionMatch || !parity.surfaceHashMatch) {
    getBrowserReliabilityEvents().record('contract_mismatch', {
      instanceId,
      detail: {
        reportedProtocolVersion: surface.protocolVersion,
        expectedProtocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
        surfaceHashMatch: parity.surfaceHashMatch,
      },
    });
  }
  if (parity.missing.length > 0 || parity.extra.length > 0) {
    getBrowserReliabilityEvents().record('tool_surface_diff', {
      instanceId,
      detail: { missing: parity.missing, extra: parity.extra },
    });
  }
  return {
    protocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
    surfaceHash: expected.surfaceHash,
    parity,
  };
}
