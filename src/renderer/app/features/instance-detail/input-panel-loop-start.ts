import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import { isCanonicalLoopPrompt } from '../loop/loop-prompt-history.service';

export interface LoopStartRequestPayload {
  config: LoopStartConfigInput;
  firstMessage: string;
  attachments: { name: string; data: Uint8Array }[];
  onResolved: (ok: boolean, error?: string) => void;
}

export interface LoopPanelStartDeps {
  isLoopStarting: () => boolean;
  panelConfig: () => LoopStartConfigInput | null;
  message: () => string;
  setMessage: (value: string) => void;
  pendingFiles: () => File[];
  setLoopStarting: (value: boolean) => void;
  setLoopArmed: (value: boolean) => void;
  setShowLoopPanel: (value: boolean) => void;
  setLoopStartError: (value: string | null) => void;
  requestLoopStart: (payload: LoopStartRequestPayload) => void;
}

export async function tryStartLoopFromPanel(
  deps: LoopPanelStartDeps,
  ackTimeoutMs: number,
): Promise<boolean> {
  if (deps.isLoopStarting()) return false;
  if (!deps.panelConfig()) {
    deps.setShowLoopPanel(true);
    deps.setLoopStartError('Loop config is incomplete - fix the prompt or settings above before sending.');
    return false;
  }

  const firstMessage = deps.message().trim();
  const attachments = await Promise.all(
    deps.pendingFiles().map(async (file) => ({
      name: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
    })),
  );

  // Reading attachments yields to model/provider and advanced-panel edits.
  // Capture their current configuration together immediately before emitting.
  const panelConfig = deps.panelConfig();
  if (!panelConfig) {
    deps.setShowLoopPanel(true);
    deps.setLoopStartError('Loop config changed while preparing attachments. Check the settings and start again.');
    return false;
  }
  const panelPrompt = panelConfig.initialPrompt.trim();
  const reviewDriven = panelConfig.completion?.mode === 'review-driven'
    || Boolean(panelConfig.completion?.crossModelReview?.pingPong?.enabled);
  const sendContinuation = Boolean(firstMessage)
    && !(reviewDriven && isCanonicalLoopPrompt(panelPrompt));
  const finalConfig: LoopStartConfigInput = {
    ...panelConfig,
    initialPrompt: firstMessage || panelPrompt,
    iterationPrompt: sendContinuation ? panelPrompt : undefined,
  };

  deps.setLoopStarting(true);
  deps.setLoopStartError(null);

  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const settle = (ok: boolean, error?: string) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    deps.setLoopStarting(false);
    if (ok) {
      deps.setLoopArmed(false);
      deps.setShowLoopPanel(false);
      deps.setMessage('');
      deps.setLoopStartError(null);
      return;
    }

    deps.setLoopArmed(true);
    deps.setShowLoopPanel(true);
    deps.setLoopStartError(error ?? 'Loop start failed.');
  };

  timeout = setTimeout(() => {
    settle(false, 'Loop start did not acknowledge within 30 seconds. No loop was confirmed; try again or check the app logs.');
  }, ackTimeoutMs);

  try {
    deps.requestLoopStart({
      config: finalConfig,
      firstMessage,
      attachments,
      onResolved: settle,
    });
  } catch (error) {
    settle(false, error instanceof Error ? error.message : String(error));
  }
  return true;
}
