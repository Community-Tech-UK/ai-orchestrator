import { computed } from '@angular/core';
export interface ComposerHintState {
  suggestion?: boolean; loopStarting?: boolean; loopArmed?: boolean; starting?: boolean;
  recovering?: boolean; compacting?: boolean; busy?: boolean; condensed?: boolean;
}
export function composerHintFor(state: ComposerHintState): string {
  if (state.suggestion) return 'Tab or → to accept suggestion';
  if (state.loopStarting) return 'Starting loop...';
  if (state.loopArmed) return 'Enter to start loop, Shift+Enter for new line';
  if (state.starting) return 'Starting up... Enter to queue, Shift+Enter for new line';
  if (state.recovering) return 'Recovering session... Enter to send after interrupt, Shift+Enter for new line';
  if (state.compacting) return 'Compacting the conversation… your message will send afterwards';
  if (state.busy) return 'Enter queues your message. Esc stops it without sending.';
  if (state.condensed) return 'Condensed context will attach when you send.';
  return 'Enter sends. Shift+Enter adds a line. / opens commands.';
}
interface HintSignals {
  showGhostText: () => boolean; loopStarting: () => boolean; loopArmed: () => boolean; isInitializing: () => boolean;
  isRespawning: () => boolean; isCompacting: () => boolean; isSteeringTarget: () => boolean; isBusy: () => boolean;
  isReplayFallback: () => boolean;
}
export function createComposerHint(panel: HintSignals) {
  return computed(() => composerHintFor({ suggestion: panel.showGhostText(), loopStarting: panel.loopStarting(),
    loopArmed: panel.loopArmed(), starting: panel.isInitializing(), recovering: panel.isRespawning(),
    compacting: panel.isCompacting(), busy: panel.isBusy() || panel.isSteeringTarget(), condensed: panel.isReplayFallback() }));
}
