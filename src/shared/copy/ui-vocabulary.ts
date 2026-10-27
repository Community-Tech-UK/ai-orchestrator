/** Canonical C7 vocabulary prerequisite for Phase 4. Broad migration and guards remain Phase 3 work. */
export const PRODUCT_NAME = 'Harness';
export interface UiTerm {
  readonly id: string;
  readonly use: string;
  readonly never: readonly RegExp[];
  readonly meaning: string;
  readonly enforcement: 'zero' | 'ratchet' | 'planned';
  readonly owner?: string;
}

export const APP_NAME_PATTERN = /(?<![./~\\-])\b(AIO|AI Orchestrator|Orchestrator|orchestrator)\b(?![-_./\\])/;

export const UI_TERMS: readonly UiTerm[] = [
  { id: 'product', use: PRODUCT_NAME, never: [APP_NAME_PATTERN], meaning: 'The app that coordinates your AI sessions.', enforcement: 'planned', owner: 'Phase 3 C7' },
  { id: 'session', use: 'session', never: [/\binstances?\b/i, /\bthreads?\b/i], meaning: 'One conversation with one AI agent.', enforcement: 'planned', owner: 'Phase 3 C7' },
  { id: 'helper-agent', use: 'Helper agent', never: [/\bchild instance\b/i], meaning: 'A session another session started to do part of the work.', enforcement: 'planned' },
  { id: 'helper-models', use: 'Helper model', never: [/\bauxiliary models?\b/i, /\baux\b/i, /\bslots?\b/i], meaning: 'A small or local model for titles, summaries and checks.', enforcement: 'planned' },
  { id: 'working', use: 'Working', never: [/Processing…/, /\bBusy\b/, /Thinking deeply…/], meaning: 'The agent is working on your request.', enforcement: 'planned', owner: 'Phase 3 C6 presenter' },
  { id: 'starting', use: 'Starting', never: [/Initializing…/, /Waking up…/, /Recovering session…/], meaning: 'The session is starting or restarting.', enforcement: 'planned', owner: 'Phase 3 C6 presenter' },
  { id: 'approval', use: 'Needs your approval', never: [/Waiting for permission/i, /Awaiting approval/i], meaning: 'The agent needs permission to take an action.', enforcement: 'planned' },
  { id: 'answer', use: 'Needs your answer', never: [/Waiting for input/i], meaning: 'The agent has asked you a question.', enforcement: 'planned' },
  { id: 'sign-off', use: 'Needs your sign-off', never: [/Needs review/], meaning: 'The loop is waiting for you to accept its work.', enforcement: 'planned' },
  { id: 'stopping', use: 'Stopping', never: [/Interrupting…/, /Cancelling…/, /Escalating interrupt…/], meaning: 'The current work is stopping.', enforcement: 'planned' },
  { id: 'ready', use: 'Ready', never: [/\bIdle\b/, /\bCancelled\b/, /\bSuperseded\b/], meaning: 'Waiting for your next message.', enforcement: 'planned' },
  { id: 'asleep', use: 'Asleep', never: [/\bHibernating\b/i, /\bHibernated\b/i, /\bDormant\b/i], meaning: 'Harness paused this session to save memory. Send a message to wake it.', enforcement: 'planned' },
  { id: 'connection-lost', use: 'Connection lost', never: [/\bDegraded\b/], meaning: 'The remote computer connection has dropped.', enforcement: 'planned' },
  { id: 'failed', use: 'Failed', never: [/^Error$/], meaning: 'The session failed.', enforcement: 'planned' },
  { id: 'closed', use: 'Closed', never: [/\bTerminated\b/], meaning: 'The session has closed.', enforcement: 'planned' },
  { id: 'shortening', use: 'compact', never: [/\[native\]/, /\[restart-with-summary\]/], meaning: 'Replaces older conversation text with a summary so it fits in the model’s memory.', enforcement: 'planned', owner: 'Phase 0 compact action keeps its name' },
  { id: 'round', use: 'round', never: [/\biteration\b/i], meaning: 'One pass of a loop.', enforcement: 'planned', owner: 'Phase 2 B9' },
  { id: 'second-opinion', use: 'Second opinion', never: [/cross-model review/i], meaning: 'Another model checks a finished turn that changed files and reports concerns.', enforcement: 'planned' },
  { id: 'auto-approve', use: 'Auto-approve', never: [/\bYOLO\b/i], meaning: 'The agent can run tools without asking you first. Risky outside a safe folder.', enforcement: 'planned' },
  { id: 'storage-buffers', use: 'Storage & buffers', never: [/^Memory$/], meaning: 'Settings for stored output and buffers.', enforcement: 'planned' },
  { id: 'phone-chat', use: 'Discord & WhatsApp', never: [/^Connections$/], meaning: 'Settings for phone chat connections.', enforcement: 'planned' },
  { id: 'connectors', use: 'Connectors', never: [], meaning: 'A tool server and its sign-in, saved once in Harness for your selected local AI sessions.', enforcement: 'planned' },
  { id: 'tool-servers', use: 'Tool servers', never: [], meaning: 'Model Context Protocol (MCP) programs give agents extra abilities, such as searching a service or reading a database.', enforcement: 'planned' },
];
