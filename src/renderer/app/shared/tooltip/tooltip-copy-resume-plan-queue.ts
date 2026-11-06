import type { TooltipCopyEntry } from './tooltip-copy';

export const RESUME_PLAN_QUEUE_COPY = {
  'planQueue.pauseRun': { label: 'Pause', meaning: 'Stops this run’s sessions now and saves work on each document’s branch. Resume carries on from there.' },
  'planQueue.resumeRun': { label: 'Resume', meaning: 'Continues this run from its saved branches once pausing has finished. Documents and checks start as slots become free.' },
  'planQueue.cancelRun': { label: 'Cancel', meaning: 'Asks first, then stops this run. Unstarted documents are skipped; work in progress is parked with its branch kept.' },
  'planQueue.skip': { label: 'Skip', meaning: 'Asks first, then leaves this unstarted document out of this run.' },
  'planQueue.refresh': { label: 'Refresh', meaning: 'Checks the disk again for leftover or missing working copies and branches.' },
  'planQueue.start': { label: 'Start run', meaning: 'Starts working through the selected documents.' },
  'planQueue.submit': { label: 'Submit answer', meaning: 'Sends this answer so the document can continue.' },
  'planQueue.chooseAnswer': { label: 'Submit answer', meaning: 'Pick an answer first.' },
  'planQueue.moveRunNoTarget': { label: 'Move to another session', meaning: 'Open another session to move this run to.' },
  'planQueue.moveRunChoose': { label: 'Move', meaning: 'Choose a session first.' },
  'planQueue.pauseAll': { label: 'Pause all', meaning: 'Stops sessions in all running plan and live-test queues now and saves their work. Resume all carries on from the saved branches.' },
  'planQueue.resumeAll': { label: 'Resume all', meaning: 'Continues all paused plan and live-test queues from their saved branches as slots become free.' },
  'planQueue.chooseParent': { label: 'Start run', meaning: 'Choose a parent session first.' },
} as const satisfies Record<string, TooltipCopyEntry>;
