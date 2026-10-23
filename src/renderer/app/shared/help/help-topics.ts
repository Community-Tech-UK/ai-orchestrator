import { GLOSSARY_HELP } from './content/glossary.help';
import { LOOP_MODE_HELP } from './content/loop.help';
import { SESSION_HELP } from './content/session.help';
import type { HelpEntry } from './help-content.types';

export type HelpTopicId = 'glossary' | 'loop' | 'session';
export const HELP_TOPICS: Record<HelpTopicId, { title: string; entry: HelpEntry }> = {
  glossary: { title: 'Words used in Harness', entry: GLOSSARY_HELP },
  loop: { title: 'Loop Mode', entry: LOOP_MODE_HELP },
  session: { title: 'Working in a session', entry: SESSION_HELP },
};
