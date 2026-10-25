export const WORKLOAD_COPY = {
  1: { name: 'Lightest', detail: '1 queue job and 2 helper agents at once. Waits when the computer is busy; background indexing waits.' },
  2: { name: 'Light', detail: '2 queue jobs and 4 helper agents at once. Waits when the computer is busy.' },
  3: { name: 'Balanced', detail: 'Uses each job’s own limits, as before.' },
  4: { name: 'Busy', detail: 'Allows more queue work at once, within the shared work folder limit.' },
  5: { name: 'Most', detail: 'Allows the most queue work and twice the background indexing, within the shared work folder limit.' },
} as const;

export type WorkloadLevel = keyof typeof WORKLOAD_COPY;
export const WORKLOAD_CONSEQUENCE = 'Changes what starts next. Running work finishes; your own messages always go through.';
