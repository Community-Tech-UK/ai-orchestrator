import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_PREAMBLE_HEADER,
  deriveAttachmentTaskTitle,
  extractAttachmentPreamble,
  frontLoadTitle,
  isBareIdentifierLine,
  isLowSignalTitle,
  sanitizeGeneratedTitle,
  standaloneDocumentPathTitle,
  titleFromAttachments,
  validateGeneratedTitle,
} from './title-derivation';
import { INSTANCE_ID_PREFIXES, ORCHESTRATION_ID_PREFIXES } from '../utils/id-generator';
import { ALL_INSTANCE_STATUSES } from '../attention/attention-level';

/** The exact prompt the loop builds when files are attached (screenshot case). */
const SCREENSHOT_PROMPT = [
  ATTACHMENT_PREAMBLE_HEADER,
  '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-05-30-mobile-control-app-plan.md',
  '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-chrome-devtools-managed-profile-attach.md',
  '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-outstanding-work-master-backlog.md',
  '',
  'Please work these files and implement them. Be thorough.',
].join('\n');

describe('extractAttachmentPreamble', () => {
  it('returns null for ordinary prompt text', () => {
    expect(extractAttachmentPreamble('Refactor the AuthService session cache')).toBeNull();
    expect(extractAttachmentPreamble('')).toBeNull();
    expect(extractAttachmentPreamble(undefined)).toBeNull();
  });

  it('parses the header, bullet paths, and trailing prompt', () => {
    const parsed = extractAttachmentPreamble(SCREENSHOT_PROMPT);
    expect(parsed).not.toBeNull();
    expect(parsed!.paths).toEqual([
      '.aio-loop-attachments/loop-1780437789286-a99d95f2/2026-05-30-mobile-control-app-plan.md',
      '.aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-chrome-devtools-managed-profile-attach.md',
      '.aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-outstanding-work-master-backlog.md',
    ]);
    expect(parsed!.remainder).toBe('Please work these files and implement them. Be thorough.');
  });

  it('tolerates a leading blank line and an empty remainder', () => {
    const parsed = extractAttachmentPreamble(`\n${ATTACHMENT_PREAMBLE_HEADER}\n- a/b.md`);
    expect(parsed).not.toBeNull();
    expect(parsed!.paths).toEqual(['a/b.md']);
    expect(parsed!.remainder).toBe('');
  });

  it('strips the "(skipped: …)" annotation from a path', () => {
    const parsed = extractAttachmentPreamble(
      `${ATTACHMENT_PREAMBLE_HEADER}\n- big.bin (skipped: too large or unwritable)`,
    );
    expect(parsed!.paths).toEqual(['big.bin']);
  });

  it('returns null when the header has no bullet paths under it', () => {
    expect(extractAttachmentPreamble(`${ATTACHMENT_PREAMBLE_HEADER}\nno bullets here`)).toBeNull();
  });
});

describe('deriveAttachmentTaskTitle', () => {
  it('titles the screenshot case from the first plan file + inferred action', () => {
    const parsed = extractAttachmentPreamble(SCREENSHOT_PROMPT)!;
    expect(deriveAttachmentTaskTitle(parsed.remainder, parsed.paths)).toBe(
      'Mobile control app implementation',
    );
  });

  it('falls back to the bare file list when no action verb is present', () => {
    expect(deriveAttachmentTaskTitle('here you go', ['a/notes.md', 'b/other.md'])).toBe(
      'notes.md +1 more',
    );
  });

  it('returns null when there are no attachment names', () => {
    expect(deriveAttachmentTaskTitle('implement this', [])).toBeNull();
  });
});

describe('titleFromAttachments', () => {
  it('uses the single label or a "+N more" summary', () => {
    expect(titleFromAttachments(['only.md'])).toBe('only.md');
    expect(titleFromAttachments(['a.md', 'b.md', 'c.md'])).toBe('a.md +2 more');
    expect(titleFromAttachments([])).toBeNull();
  });
});

describe('standaloneDocumentPathTitle', () => {
  const planPath = '/Users/suas/work/Dingley/dingley-kpi/dingley-kpi-fe/docs/superpowers/plans/2026-09-23-kpi-workbook-alignment-and-data-load_plan.md';

  it('uses the document filename rather than its parent folders', () => {
    expect(standaloneDocumentPathTitle(planPath)).toBe('KPI workbook alignment and data load');
    expect(frontLoadTitle(planPath)).toBe('KPI workbook alignment and data load');
  });

  it('leaves ordinary messages and non-document paths alone', () => {
    expect(standaloneDocumentPathTitle('Please read docs/superpowers/plans/plan.md')).toBeNull();
    expect(standaloneDocumentPathTitle('/Users/suas/work/project')).toBeNull();
    expect(standaloneDocumentPathTitle(`${planPath}\nPlease implement it`)).toBeNull();
  });
});

describe('sanitizeGeneratedTitle', () => {
  it('unwraps stored markdown titles while preserving structural truncation markers', () => {
    expect(sanitizeGeneratedTitle('**Outlook email routing**')).toBe('Outlook email routing');
    expect(sanitizeGeneratedTitle('`Work Finder filters...`', { preserveTruncationMarker: true }))
      .toBe('Work Finder filters...');
    expect(sanitizeGeneratedTitle('**Question 5**')).toBe('Question 5');
  });
  it('removes closed XML and bracket thinking blocks', () => {
    expect(sanitizeGeneratedTitle('<think>reasoning</think>\nTab rename sanitizer')).toBe(
      'Tab rename sanitizer',
    );
    expect(sanitizeGeneratedTitle('[thinking]reasoning[/thinking]\nTab rename sanitizer')).toBe(
      'Tab rename sanitizer',
    );
  });

  it('rejects unfinished thinking tags', () => {
    expect(sanitizeGeneratedTitle('<think>reasoning only')).toBeNull();
    expect(sanitizeGeneratedTitle('[THINKING]reasoning only')).toBeNull();
  });
});

describe('validateGeneratedTitle', () => {
  it.each([
    '1. Work Finder job search filters and contextual summary of the session',
    '1. Work Finder filters\n2. Saved searches',
    '1)Work Finder filters', '1.Work Finder filters', '١)Work Finder filters',
    '１.Work Finder filters', '1)123 OAuth repairs',
    '1: Work Finder filters', '1 - Work Finder filters', '(1) Work Finder filters',
    '## Work Finder filters', '١:Work Finder filters', '１: Work Finder filters',
    '- Work Finder filters',
    '• Work Finder filters',
    '**1. Work Finder filters**',
    'Work Finder filters\nThe task concerned saved searches.',
    'Work Finder filters. The task concerned saved searches.',
    'Work Finder filters. the task concerned saved searches.',
    'The session involved improving Work Finder filters',
    'I will summarize the Work Finder session',
    'Here is the title: Work Finder filters',
    'Title: Work Finder filters',
    '```\nWork Finder filters\n```',
    '<think>Need a title',
    '1.',
    '42',
    '１２３', '١٢٣', 'Question ١٢٣', 'Please continue １２３',
    '1ed2be54-1026-428c-a407-9a52c835759b',
    '0123456789abcdef0123456789abcdef',
    'Please continue',
    'Yes',
    'Okay',
    'Done',
    'Completed', 'Finished', 'Task completed', 'Task complete', 'In progress', 'Success',
    'Pending', 'Work completed successfully', 'All tasks completed', 'Session ready',
    'In-progress', 'Task-completed',
    'All work has been completed', 'We are done', 'All set', 'Awaiting instructions',
    'Waiting for input', 'Not yet completed', 'No changes needed', 'No action required',
    'Currently in progress', 'Still working', 'Cancelled', 'Work is complete',
    'cz3mwn04e', 'Cz3mwn04e', 'x8f3k2m1p', 's7j4x1q9w',
    'All tests passed', 'Finished without errors', 'Ready for testing', 'Needs clarification',
    'I am done', 'Nothing to report', 'Ready to assist', 'No issues found',
    'Everything looks good', 'In process', 'Acknowledged', 'Understood', 'No problem',
    'Happy to help', 'Ready for your request', 'All checks look fine', 'No issues detected',
    'No further assistance needed', 'Everything appears normal',
    'I’m done', "I'm ready to assist", "We've found no issues",
    "Job completed", "Operation successful", "Activity in progress",
    "Result ready", "All requests processed", "Ready when you are",
    "No more changes needed", "No additional action needed", "Analysis complete",
    "Response provided", "Successfully processed", "Task handled",
    "Standing by", "Waiting for next instruction", "Completed as requested",
    "Execution complete", "No errors encountered", "Help available",
    "Work accomplished", "Everything working perfectly", "Nothing left to do",
    "No outstanding issues", "Pending confirmation", "Ready to answer",
    "Preparing response", "Proceeding with task", "Action taken",
    "Request accepted", "Task wrapped up", "No change required",
    "No fixes needed", "Investigation complete", "Done investigating",
    "Task completion", "Assistant ready", "Agent ready",
    'Be thorough',
    "Short title",
    "Suggested title",
    "Proposed name",
    "Recommended heading",
    "Concise summary",
    "Brief session",
    "Candidate title",
    "Descriptive name",
    "Final title",
    "Title suggestion",
    "Suggested name",
    "Name proposal",
    "Session recommendation",
    "Untitled thread",
    "Untitled session",
    "New conversation",
    "New chat",
    "Untitled",
    "Unnamed",
    "Unnamed session",
    "New session",
    "New thread",
    "Empty conversation",
    "Default session",
    "Unknown task",
    "No subject",
    "No title",
    "Session title",
    "Conversation name",
    "Untitled chat",
    "Untitled conversation",
    "New task",
    "Unknown subject",
    "Idle",
    "Busy",
    "Initializing",
    "Terminated",
    "Hibernated",
    "Hibernating",
    "Waking",
    "Approved",
    "Rejected",
    "Denied",
    "Aborted",
    "Awaiting command",
    "Acknowledging receipt",
    "Pending approval",
    "Session initialized",
    "Request rejected",
    "Task aborted",
    "Request approved",
    "Request denied",
    "Suggested title: Work Finder watchdog",
    'Topic: Work Finder watchdog',
    'Suggested topic: Work Finder watchdog',
    'Here is the suggested topic: Work Finder watchdog',
    'Task: Work Finder watchdog',
    'Suggested task: Work Finder watchdog',
    'Subject: Work Finder watchdog',
    'Suggested subject: Work Finder watchdog',
    'Tab: Work Finder watchdog',
    'Suggested tab: Work Finder watchdog',
    'Summary: Work Finder watchdog',
    'Suggested summary: Work Finder watchdog',
    "Here is the suggested title: Work Finder watchdog",
    "Recommended name for this session: Work Finder watchdog",
    "Candidate heading: Work Finder watchdog",
    "Here’s a proposed title: Work Finder watchdog",
    "Title — Work Finder watchdog",
    "Suggested title -Work Finder watchdog",
    "I've fixed Work Finder watchdog",
    "We’re investigating Work Finder watchdog",
    "You should check Work Finder watchdog",
    "1– Work Finder watchdog",
    "1 -Work Finder watchdog",
    "1—Work Finder watchdog",
    "1- Work Finder watchdog",
    "I'm fixing this",
    "Fixing this issue",
    "Reviewing this request",
    "Investigating this problem",
    "Debugging this issue",
    "Handling this request",
    "Resolving this issue",
    "Completing this task",
    "Implementing this request",
    "Processing this request",
    "Reporting this issue",
    "Assisting with this task",
    "Investigations completed",
    "Agents ready",
    "Assistants awaiting instructions",
    "Requesting assistance",
    "Needing more input",
    "Addressing this issue",
    "Helping with this request",
    "Looking at this issue",
    "Verifying this task",
    "Applying changes",
    "Accepting this request",
    "Delivering the result",
    "Executing this task",
    "Achieving completion",
    "Accomplishing this task",
    "Concluding the investigation",
    "Satisfying this request",
    "Detecting issues",
    "Observing the issue",
    "Identifying this issue",
    "Answering this request",
    "Replying to this request",
    "Wrapping up this task",
    "Resuming this task",
    "Restarting this task",
    "Stopping this task",
    "Pausing this task",
    "Cancelling this task",
    "Restoring the session",
    '**Question 5**',
    'Step 2',
    'Option 1',
  ])('rejects unusable model output %j before rail formatting', (raw) => {
    expect(validateGeneratedTitle(raw)).toBeNull();
  });

  it.each([
    ['**Work Finder filters**', 'Work Finder filters'],
    ['`Work Finder filters`', 'Work Finder filters'],
    ['"Work Finder filters"', 'Work Finder filters'],
    ['“Work Finder filters”', 'Work Finder filters'],
    ['**"Work Finder filters"**', 'Work Finder filters'],
    ['<think>reasoning</think>\nWork Finder filters.', 'Work Finder filters'],
    ['[THINKING]reasoning[/THINKING]\nOAuth2 HTTP 500', 'OAuth2 HTTP 500'],
    ['auth_service.ts parser', 'auth_service.ts parser'],
    ['C++ parser errors', 'C++ parser errors'],
    ['Request-handler', 'Request-handler'],
    ['Done button accessibility', 'Done button accessibility'],
    ['Task runner scheduling', 'Task runner scheduling'],
    ['Work Finder progress tracking', 'Work Finder progress tracking'],
    ['OAuth2 migration completed', 'OAuth2 migration completed'],
    ['Work Finder is complete', 'Work Finder is complete'],
    ['No OAuth changes needed', 'No OAuth changes needed'],
    ['component', 'component'], ['container', 'container'], ['community', 'community'],
    ['Angular22', 'Angular22'], ['Copilot22', 'Copilot22'], ['GPT500abc', 'GPT500abc'],
    ['HTTP error handling', 'HTTP error handling'],
    ['OAuth2 verification fixes', 'OAuth2 verification fixes'],
    ['1.2 compatibility repairs', '1.2 compatibility repairs'],
    ['Angular ２２ migration', 'Angular ２２ migration'],
    ['Report pagination', 'Report pagination'], ['Work Finder issues found', 'Work Finder issues found'],
    ['HTTP process diagnostics', 'HTTP process diagnostics'], ['404 error diagnostics', '404 error diagnostics'],
    ['HTTP 500: gateway faults', 'HTTP 500: gateway faults'], ['3D renderer fixes', '3D renderer fixes'],
    ['Job runner metrics', 'Job runner metrics'], ['Operation logs routing', 'Operation logs routing'],
    ['Analysis dashboard layout', 'Analysis dashboard layout'], ['Result table sorting', 'Result table sorting'],
    ['Execution trace viewer', 'Execution trace viewer'], ['Agent settings editor', 'Agent settings editor'],
    ["I/O stream diagnostics", "I/O stream diagnostics"],
    ["IT inventory sync", "IT inventory sync"],
    ["2-factor authentication fixes", "2-factor authentication fixes"],
    ["64-bit migration", "64-bit migration"],
    ["3-D renderer faults", "3-D renderer faults"],
    ["Work Finder title: parsing fixes", "Work Finder title: parsing fixes"],
    ['Work Finder topic editor', 'Work Finder topic editor'],
    ['Tab layout accessibility', 'Tab layout accessibility'],
    ['Summary dashboard rendering', 'Summary dashboard rendering'],
    ['Session-settings', 'Session-settings'],
    ["New chat message routing", "New chat message routing"],
    ["Title editor accessibility", "Title editor accessibility"],
    ["Default theme contrast", "Default theme contrast"],
    ["Unknown HTTP status handling", "Unknown HTTP status handling"],
    ["Idle timeout diagnostics", "Idle timeout diagnostics"],
    ["Permission editor accessibility", "Permission editor accessibility"],
    ["Thread restore routing", "Thread restore routing"],
    ["Untitled document rendering", "Untitled document rendering"],
    ["Chat history pagination", "Chat history pagination"],
  ])('accepts one useful plain title from %j', (raw, expected) => {
    expect(validateGeneratedTitle(raw)).toBe(expected);
  });

  it('rejects overlong narration rather than turning it into a title', () => {
    expect(validateGeneratedTitle('Work Finder search filters ' + 'and contextual details '.repeat(5)))
      .toBeNull();
  });

  it('rejects residual emphasis markers left by partial unwrapping', () => {
    expect(validateGeneratedTitle('*bold* and *more*')).toBeNull();
    expect(validateGeneratedTitle('*unclosed emphasis')).toBeNull();
  });
});

describe('isLowSignalTitle', () => {
  it.each([
    '', '1', '1.', '(42)', '1.2.3', '123456789', 'yes', 'OK.', 'Done',
    '１２３', '١٢٣', '(١٢٣)', 'Question ١٢٣', 'Please continue １２３',
    'Please continue', 'Okay thanks', 'Fix this', 'Please continue 1.',
    'Completed', 'Finished', 'Task completed', 'Task complete', 'In progress', 'Success',
    'Pending', 'Work completed successfully', 'All tasks completed', 'Session ready',
    'Instance 1771720410089', 'In-progress', 'Task-completed',
    'All work has been completed', 'We are done', 'All set', 'Awaiting instructions',
    'Waiting for input', 'Not yet completed', 'No changes needed', 'No action required',
    'Currently in progress', 'Still working', 'Cancelled', 'Work is complete',
    'The task is complete', 'cz3mwn04e', 'Cz3mwn04e', 'x8f3k2m1p', 's7j4x1q9w',
    'All tests passed', 'Finished without errors', 'Ready for testing', 'Needs clarification',
    'I am done', 'Nothing to report', 'Ready to assist', 'No issues found',
    'Everything looks good', 'In process', 'Acknowledged', 'Understood', 'No problem',
    'Happy to help', 'Ready for your request', 'All checks look fine', 'No issues detected',
    'No further assistance needed', 'Everything appears normal',
    'I’m done', "I'm ready to assist", "We've found no issues",
    "Job completed", "Operation successful", "Activity in progress",
    "Result ready", "All requests processed", "Ready when you are",
    "No more changes needed", "No additional action needed", "Analysis complete",
    "Response provided", "Successfully processed", "Task handled",
    "Standing by", "Waiting for next instruction", "Completed as requested",
    "Execution complete", "No errors encountered", "Help available",
    "Work accomplished", "Everything working perfectly", "Nothing left to do",
    "No outstanding issues", "Pending confirmation", "Ready to answer",
    "Preparing response", "Proceeding with task", "Action taken",
    "Request accepted", "Task wrapped up", "No change required",
    "No fixes needed", "Investigation complete", "Done investigating",
    "Task completion", "Assistant ready", "Agent ready",
    'Question 5', 'Step 2', 'Option 1', '**Question 5**', '`Option 1`', '**1.**',
    "Short title",
    "Suggested title",
    "Proposed name",
    "Recommended heading",
    "Concise summary",
    "Brief session",
    "Candidate title",
    "Descriptive name",
    "Final title",
    "Title suggestion",
    "Suggested name",
    "Name proposal",
    "Session recommendation",
    "Untitled thread",
    "Untitled session",
    "New conversation",
    "New chat",
    "Untitled",
    "Unnamed",
    "Unnamed session",
    "New session",
    "New thread",
    "Empty conversation",
    "Default session",
    "Unknown task",
    "No subject",
    "No title",
    "Session title",
    "Conversation name",
    "Untitled chat",
    "Untitled conversation",
    "New task",
    "Unknown subject",
    "Idle",
    "Busy",
    "Initializing",
    "Terminated",
    "Hibernated",
    "Hibernating",
    "Waking",
    "Approved",
    "Rejected",
    "Denied",
    "Aborted",
    "Awaiting command",
    "Acknowledging receipt",
    "Pending approval",
    "Session initialized",
    "Request rejected",
    "Task aborted",
    "Request approved",
    "Request denied",
    "I'm fixing this",
    "Fixing this issue",
    "Reviewing this request",
    "Investigating this problem",
    "Debugging this issue",
    "Handling this request",
    "Resolving this issue",
    "Completing this task",
    "Implementing this request",
    "Processing this request",
    "Reporting this issue",
    "Assisting with this task",
    "Investigations completed",
    "Agents ready",
    "Assistants awaiting instructions",
    "Requesting assistance",
    "Needing more input",
    "Addressing this issue",
    "Helping with this request",
    "Looking at this issue",
    "Verifying this task",
    "Applying changes",
    "Accepting this request",
    "Delivering the result",
    "Executing this task",
    "Achieving completion",
    "Accomplishing this task",
    "Concluding the investigation",
    "Satisfying this request",
    "Detecting issues",
    "Observing the issue",
    "Identifying this issue",
    "Answering this request",
    "Replying to this request",
    "Wrapping up this task",
    "Resuming this task",
    "Restarting this task",
    "Stopping this task",
    "Pausing this task",
    "Cancelling this task",
    "Restoring the session",
    '1ed2be54-1026-428c-a407-9a52c835759b',
    '0123456789abcdef0123456789abcdef', 'instance-123456789',
    'codex-1772759207884-oc6cdv',
  ])('recognizes filler or a bare identifier %j', (title) => {
    expect(isLowSignalTitle(title)).toBe(true);
  });

  it.each([
    'OAuth2', 'HTTP 500', 'OAuth2 HTTP 500', 'Angular 22', 'MyTradeMail 2',
    'Fix Work Finder filters', 'Continue OAuth2 migration', 'Request-handler',
    'Done button accessibility', 'session-settings',
    'Question 5 scoring', 'Step 2 migration', 'Option 1 comparison',
    'Task runner scheduling', 'Work Finder progress tracking', 'OAuth2 migration completed',
    'Work Finder is complete', 'No OAuth changes needed', 'User input validation',
    'component', 'container', 'community', 'Angular22', 'Copilot22', 'GPT500abc',
    'HTTP error handling', 'OAuth2 verification fixes',
    '1.2 compatibility repairs', 'Angular ２２ migration',
    'Report pagination', 'Work Finder issues found', 'HTTP process diagnostics',
    '404 error diagnostics', 'HTTP 500: gateway faults', '3D renderer fixes',
    'Job runner metrics', 'Operation logs routing', 'Analysis dashboard layout',
    'Result table sorting', 'Execution trace viewer', 'Agent settings editor',
    "New chat message routing",
    "Title editor accessibility",
    "Default theme contrast",
    "Unknown HTTP status handling",
    "Idle timeout diagnostics",
    "Permission editor accessibility",
    "Thread restore routing",
    "Untitled document rendering",
    "Chat history pagination",
    "I/O stream diagnostics",
    "IT inventory sync",
    "2-factor authentication fixes",
    "64-bit migration",
    "3-D renderer faults",
    "Work Finder title: parsing fixes",
  ])('preserves useful title %j', (title) => {
    expect(isLowSignalTitle(title)).toBe(false);
  });
});

describe('canonical lifecycle title quality', () => {
  it.each(ALL_INSTANCE_STATUSES)('rejects bare lifecycle status %s as an automatic title', (status) => {
    expect(isLowSignalTitle(status)).toBe(true);
    expect(validateGeneratedTitle(status)).toBeNull();
  });
});

describe('isBareIdentifierLine Harness IDs', () => {
  it.each([...Object.values(INSTANCE_ID_PREFIXES), ...Object.values(ORCHESTRATION_ID_PREFIXES)])(
    'recognizes random-looking IDs for registered prefix %s, including front-loaded capitalization', (prefix) => {
      expect(isBareIdentifierLine(`${prefix}8f3k2m1p`)).toBe(true);
      expect(isBareIdentifierLine(`${prefix.toUpperCase()}8f3k2m1p`)).toBe(true);
      expect(isBareIdentifierLine(`${prefix}8f3k2m1p OAuth repair`)).toBe(false);
    },
  );
});
