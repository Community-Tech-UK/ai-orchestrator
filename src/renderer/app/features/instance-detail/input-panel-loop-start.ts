import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import { isCanonicalLoopPrompt } from '../loop/loop-prompt-history.service';
import { readStagedFiles, StagedFileError, type HeicConverter } from '../../core/state/instance/instance-attachments';

const SWITCHED_BEFORE_START = 'The loop was not started because you switched session while it was getting ready. '
  + 'Your message and attachments are still in that session.';
const SWITCHED_START_UNCONFIRMED = 'The loop in the session you left may not have started. Open that session to check.';

export interface LoopStartRequestPayload {
  config: LoopStartConfigInput;
  firstMessage: string;
  attachments: { name: string; data: Uint8Array }[];
  /** The staged files these attachments were read from, so the host unstages exactly these once the loop starts. */
  stagedFiles: File[];
  onResolved: (ok: boolean, error?: string) => void;
}

export interface LoopPanelStartDeps {
  /**
   * The session this composer is showing: the one its host starts the loop in. The composer is reused across
   * sessions, and hosts pick the session shown when the request arrives, so a switch while attachments are
   * prepared must not reach them.
   */
  sessionId: () => string;
  /** Tells the user about a start they can no longer see in this composer, because they switched session. */
  notify: (message: string, kind?: 'warning' | 'error') => void;
  isLoopStarting: () => boolean;
  panelConfig: () => LoopStartConfigInput | null;
  message: () => string;
  setMessage: (value: string) => void;
  pendingFiles: () => File[];
  /** Loop attachments are opened by the agent from disk, and agents cannot read HEIC photos. */
  convertHeic: HeicConverter;
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

  const sessionId = deps.sessionId();
  const firstMessage = deps.message().trim();
  const stagedFiles = deps.pendingFiles();
  // Starting from here, not after the attachments are ready: converting a HEIC photo takes long enough for a
  // second Enter to arrive, and that must not start a second loop.
  deps.setLoopStarting(true);
  deps.setLoopStartError(null);
  let attachments: LoopStartRequestPayload['attachments'];
  try {
    attachments = await readStagedFiles(stagedFiles, deps.convertHeic, async (file) => ({
      name: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
    }));
  } catch (error) {
    console.warn('Loop start: could not prepare attachments', error);
    deps.setLoopStarting(false);
    if (deps.sessionId() !== sessionId) {
      deps.notify(SWITCHED_BEFORE_START);
      return false;
    }
    deps.setShowLoopPanel(true);
    deps.setLoopStartError(error instanceof StagedFileError ? error.visibleMessage : 'The attachments could not be prepared. Try again.');
    return false;
  }

  if (deps.sessionId() !== sessionId) {
    // Starting it here would start it in the session now shown, with the other session's message and files.
    // Both are still saved with the session they came from.
    deps.setLoopStarting(false);
    deps.notify(SWITCHED_BEFORE_START);
    return false;
  }

  // Reading attachments yields to model/provider and advanced-panel edits.
  // Capture their current configuration together immediately before emitting.
  const panelConfig = deps.panelConfig();
  if (!panelConfig) {
    deps.setLoopStarting(false);
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

  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const settle = (ok: boolean, error?: string) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    deps.setLoopStarting(false);
    if (deps.sessionId() !== sessionId) {
      // The request had already gone to the right session, but this composer now shows another one: leave its text
      // alone. The loop panel is shared by every session, so a started loop still closes it.
      if (ok) {
        deps.setLoopArmed(false);
        deps.setShowLoopPanel(false);
        deps.setLoopStartError(null);
      } else {
        deps.notify(SWITCHED_START_UNCONFIRMED, 'error');
      }
      return;
    }
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
      stagedFiles,
      onResolved: settle,
    });
  } catch (error) {
    settle(false, error instanceof Error ? error.message : String(error));
  }
  return true;
}
