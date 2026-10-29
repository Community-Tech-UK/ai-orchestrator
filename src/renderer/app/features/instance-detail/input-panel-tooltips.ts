import { copyFor } from '../../shared/tooltip/tooltip-copy';
import type { InputPanelComponent } from './input-panel.component';

interface VoiceTooltipContext {
  isDraftComposer(): boolean;
  isInitializing(): boolean;
  disabled(): boolean;
  isVoiceActive(): boolean;
}

/** Pure presentation decision; callers supply current state without Angular dependencies. */
export function voiceTooltipParts(context: VoiceTooltipContext) {
  if (context.isVoiceActive()) return { name: copyFor('composer.voiceStop'), disabledReason: null };
  const name = copyFor('composer.voiceStart');
  if (context.isDraftComposer()) return { name, disabledReason: copyFor('composer.voiceDraft') };
  if (context.isInitializing()) return { name, disabledReason: copyFor('composer.voiceStarting') };
  if (context.disabled()) return { name, disabledReason: copyFor('composer.voiceUnavailable') };
  return { name, disabledReason: null };
}

/** Keep presentation decisions out of the already-large composer component. */
export function composerSendDisabledReason(panel: InputPanelComponent): string | null {
  if (panel.disabled()) return copyFor('composer.inputUnavailable');
  if (panel.runReadiness.blocking()) return copyFor('composer.readinessBlocked');
  if (panel.isDraftComposer() && panel.copilotRouteBlocked()) return copyFor('composer.accountRequired');
  if (!panel.loopArmed() && !panel.message().trim() && !panel.pendingFiles().length && !panel.pendingFolders().length) {
    return copyFor('composer.contentRequired');
  }
  return null;
}
