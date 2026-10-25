import type { GlobalPauseState } from '@contracts/schemas/global-pause';

export function workControlLabel(state: GlobalPauseState, missingSessions: number): string {
  if (state.resumeInterrupted) return 'Resume was interrupted · Resume the rest';
  switch (state.phase) {
    case 'holding':
      return state.stale && state.since
        ? `Holding new work since ${new Date(state.since).toLocaleDateString(undefined, { weekday: 'long' })} · Release`
        : 'Holding new work · Release';
    case 'collecting': return `Writing notes: ${state.completedNotes} of ${state.totalNotes}`;
    case 'ready':
      if (state.stale) return 'Paused 3 days or more · Resume or discard';
      return missingSessions > 0
        ? `Paused for restart, ${missingSessions} sessions waiting · Resume`
        : 'Safe to restart · Resume';
    case 'resuming': return 'Resuming work';
    default: return 'Work';
  }
}
