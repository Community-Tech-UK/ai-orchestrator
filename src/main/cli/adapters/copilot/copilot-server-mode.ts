/**
 * WS14 — server-mode startup for the Copilot adapter: probe the bundled SDK,
 * open the persistent session, wire the turn bridge, and compute the
 * spawn-time session-continuity proof (B2). Extracted from the adapter so the
 * adapter file stays within its LOC ceiling and the startup logic is
 * independently testable.
 *
 * Returns null when server mode is unavailable or fails to start — callers
 * keep the exec-per-message path, verbatim.
 */

import { getLogger } from '../../../logging/logger';
import type { ResumeAttemptResult } from '../base-cli-adapter';
import { COPILOT_AUTO_MODEL_ID } from '../copilot-cli-adapter.types';
import { loadCopilotSdk } from './copilot-sdk-loader';
import { CopilotServerSession } from './copilot-server-session';
import { CopilotServerTurnBridge, type CopilotServerBridgeHost } from './copilot-server-turn-bridge';

const logger = getLogger('CopilotServerMode');

export interface CopilotServerModeResult {
  session: CopilotServerSession;
  bridge: CopilotServerTurnBridge;
  /** Copilot-side session id after start (new or resumed). */
  copilotSessionId: string | null;
  /** Spawn-time session-continuity proof (B2). */
  resumeProof: ResumeAttemptResult;
}

export interface CopilotServerModeParams {
  workingDir?: string;
  model?: string;
  resumeSessionId: string | null;
  host: CopilotServerBridgeHost;
  /** Exec fallback bookkeeping when startup fails. */
  onFallback(reason: string): void;
}

export async function startCopilotServerMode(
  params: CopilotServerModeParams,
): Promise<CopilotServerModeResult | null> {
  const sdk = loadCopilotSdk();
  if (!sdk) return null;
  try {
    const bridge = new CopilotServerTurnBridge(params.host);
    const configuredModel = params.model?.trim();
    const session = await CopilotServerSession.start({
      sdk,
      workingDirectory: params.workingDir,
      // 'auto' delegates routing to the runtime — omit the model entirely.
      ...(configuredModel && configuredModel.toLowerCase() !== COPILOT_AUTO_MODEL_ID
        ? { model: configuredModel }
        : {}),
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      // Parity with exec mode's posture (--allow-all-tools/paths/urls): the
      // orchestrator is the approval layer. Recorded as a WS14 deviation —
      // finer per-request bridging rides supportsPermissionPrompts later.
      onPermissionRequest: async () => ({ kind: 'approved' }),
      onEffect: (effect) => bridge.handleEffect(effect),
    });
    // Session continuity proof (B2): a successful resumeSession IS the
    // native-resume confirmation; a fresh session records fresh-fallback.
    const resumeProof: ResumeAttemptResult = params.resumeSessionId
      ? {
          source: 'native',
          confirmed: session.copilotSessionId === params.resumeSessionId,
          requestedSessionId: params.resumeSessionId,
          ...(session.copilotSessionId ? { actualSessionId: session.copilotSessionId } : {}),
        }
      : { source: 'fresh-fallback', confirmed: false };
    logger.info('Copilot adapter using SDK server mode', {
      sdkVersion: sdk.packageVersion,
      resumed: Boolean(params.resumeSessionId),
    });
    return { session, bridge, copilotSessionId: session.copilotSessionId, resumeProof };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Copilot server mode failed to start — using exec fallback', { error: reason });
    params.onFallback(reason);
    return null;
  }
}
