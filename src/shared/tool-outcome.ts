/**
 * What "failed" means for each kind of tool result, in one place.
 *
 * Until now a Codex command that exited non-zero was written to the transcript
 * as `is_error: true`, so `rg` finding nothing (exit 1) and `git diff
 * --exit-code` reporting a difference read as failures, while every reader of the
 * flag (the loop activity record, the tool-loop wiring, the correction miner)
 * quietly depended on that. The rule is now per tool kind:
 *
 *  - **edit / write**: failed when the tool reported an error (`is_error`).
 *  - **command**: `is_error` means the provider says the command DID NOT RUN TO
 *    ITS OWN EXIT: it was declined, it failed without ever reporting an exit
 *    status, it carried an explicit error flag, or the provider reported a
 *    timeout or a signal. A status the command supplied is neutral whatever the
 *    number (a script may exit 124, 127 or 137 on purpose; 127 is not proof that
 *    a command was missing), so it is never read as "could not run". It stays in
 *    `exitCode` and reads "Exited with status N". The exception is a *check*
 *    (tests, lint, build, typecheck): a check that does not pass is a real failure
 *    for the loop and for the turn note, recorded as `checkFailed`, but only when
 *    the failure can fairly be blamed on the check. A shell chain's status is that
 *    of the last command that ran, so `git pull && npm test` and `npm test | tail`
 *    are left unmarked: the text cannot say which step failed.
 *  - **anything else** (reads, searches, MCP and web tools): failed when
 *    `is_error`.
 *
 * Producers (the Codex app-server and exec transcripts, and the ACP adapters for
 * Cursor, Grok, Copilot and OpenCode) publish `is_error`, `exitCode`, `isCheck`
 * and `checkFailed` on a command's `tool_result` metadata; readers call
 * `isToolResultFailed` instead of reading `is_error` alone. This is not
 * `shared/types/tool-outcome.ts`, which builds the miner's invisible
 * `tool_outcome` record; that one carries the already-decided flag.
 */

/** Words that make a command look like a verification run (the Codex adapter's phase pattern). */
export const VERIFICATION_CMD_PATTERN = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;

export type ToolKind = 'command' | 'edit' | 'other';

const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd', 'execute', 'exec', 'command_execution', 'run_command', 'terminal',
]);

const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'patch', 'edit_file', 'write_file', 'editfile', 'createfile', 'file_change',
]);

/** Which failure rule applies to a tool, from its name. Unknown names are `other`. */
export function toolKindOf(toolName: string | undefined): ToolKind {
  const name = toolName?.trim().toLowerCase();
  if (!name) return 'other';
  if (COMMAND_TOOL_NAMES.has(name)) return 'command';
  if (EDIT_TOOL_NAMES.has(name)) return 'edit';
  return 'other';
}

// ---- Is this command a check? ---------------------------------------------------

/**
 * Programs that look at or print text. A command that starts with one never
 * counts as a check, however many "test" words its arguments hold: `rg test src`
 * exits 1 when nothing matches, and that is not a failing test run.
 */
const NON_CHECK_PROGRAMS: ReadonlySet<string> = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'find', 'fd', 'cat', 'head', 'tail', 'less', 'more', 'ls', 'tree',
  'wc', 'sed', 'awk', 'echo', 'printf', 'sort', 'uniq', 'cut', 'tee', 'tr', 'nl', 'column', 'jq', 'diff', 'cmp',
  'git', 'cd', 'pwd', 'stat', 'file', 'which', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'test', '[', 'true', 'false',
]);

const PREFIX_WRAPPERS: ReadonlySet<string> = new Set(['time', 'sudo', 'nice', 'nohup', 'command', 'env', 'exec']);

/** `bash -lc '…'`, `cmd /c "…"`, `powershell -Command "…"`: the command the shell was asked to run. */
const SHELL_INVOCATIONS: readonly RegExp[] = [
  /^\s*(?:\S*[\\/])?(?:ba|z|da|k|c|tc|a)?sh(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+(['"])([\s\S]*)\1\s*$/,
  /^\s*(?:\S*[\\/])?cmd(?:\.exe)?\s+\/[cC]\s+(['"]?)([\s\S]*?)\1\s*$/,
  /^\s*(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-\S+\s+)*-[Cc]ommand\s+(['"]?)([\s\S]*?)\1\s*$/,
];

function unwrapShellInvocation(command: string): string {
  for (const pattern of SHELL_INVOCATIONS) {
    const match = pattern.exec(command);
    if (match) return unwrapShellInvocation(match[2]);
  }
  return command;
}

function programOf(segment: string): string {
  const tokens = segment.trim().split(/\s+/);
  let index = 0;
  while (index < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[index]) || PREFIX_WRAPPERS.has(tokens[index]))) index++;
  if (tokens[index] === 'rtk') {
    index++;
    if (tokens[index] === 'proxy') index++;
  }
  const first = (tokens[index] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  return (first.split(/[\\/]/).pop() ?? first).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

function withoutQuotedText(segment: string): string {
  return segment.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
}

/** `<<EOF`, `<<-'EOF'`: starts a here-document, whose body is text, not commands. */
const HEREDOC_START = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w-]*)\2/;

/** Index of the last character of a here-document (its terminator line), or the end of the command. */
function endOfHeredoc(command: string, from: number, word: string, stripTabs: boolean): number {
  let lineStart = from;
  while (lineStart < command.length) {
    const eol = command.indexOf('\n', lineStart);
    const lineEnd = eol === -1 ? command.length : eol;
    const line = command.slice(lineStart, lineEnd).replace(/\r$/, '');
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === word) return lineEnd;
    if (eol === -1) break;
    lineStart = eol + 1;
  }
  return command.length;
}

/** How a step is joined to the one before it: `|` makes a pipeline, the rest make a command list. */
type StepJoiner = 'start' | '&&' | '||' | ';' | '|';

interface ShellStep {
  text: string;
  joiner: StepJoiner;
}

/**
 * Split `a && b | c; d` into its steps, ignoring operators inside quotes (`rg
 * "a|b" src` is one step) and the bodies of here-documents (a `cat > notes.md
 * <<EOF` that mentions "tests" is not a test run).
 */
function splitShellSteps(command: string): ShellStep[] {
  const steps: ShellStep[] = [];
  let current = '';
  let joiner: StepJoiner = 'start';
  const endStep = (next: StepJoiner): void => {
    steps.push({ text: current, joiner });
    current = '';
    joiner = next;
  };
  let quote: string | null = null;
  let heredoc: { word: string; stripTabs: boolean } | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === '\\' && quote === '"') {
        current += char + (command[i + 1] ?? '');
        i++;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const start = HEREDOC_START.exec(command.slice(i, i + 80));
      if (start) {
        heredoc = { word: start[3], stripTabs: start[1] === '-' };
        current += start[0];
        i += start[0].length - 1;
        continue;
      }
    }
    if (char === '\n' && heredoc) {
      endStep(';');
      i = endOfHeredoc(command, i + 1, heredoc.word, heredoc.stripTabs);
      heredoc = null;
      continue;
    }
    const twoChars = command.slice(i, i + 2);
    if (twoChars === '&&' || twoChars === '||') {
      endStep(twoChars);
      i++;
    } else if (char === '|') {
      endStep('|');
    } else if (char === ';' || char === '\n') {
      endStep(';');
    } else {
      current += char;
    }
  }
  endStep('start');
  return steps;
}

/** Peel the grouping characters off a step: `(cd app` and `npm test)` read as `cd app` and `npm test`. */
function stepText(step: ShellStep): string {
  return step.text.replace(/^[\s({]+/, '').replace(/[\s)};]+$/, '');
}

function isCheckStep(step: ShellStep): boolean {
  const text = stepText(step);
  return !NON_CHECK_PROGRAMS.has(programOf(text)) && VERIFICATION_CMD_PATTERN.test(withoutQuotedText(text));
}

/**
 * Inert builtins that cannot mask a failure without redirections. Directory
 * changes, environment changes and exit/return can fail or override status. An empty step
 * (a trailing `;`) counts too.
 */
const HARMLESS_PROGRAMS: ReadonlySet<string> = new Set([
  '', 'true', ':',
]);

function isHarmlessPipeline(stages: readonly ShellStep[]): boolean {
  return stages.every((stage) => HARMLESS_PROGRAMS.has(programOf(stepText(stage))) && !/[<>]/.test(stepText(stage)));
}

/** Group steps into pipelines: every step joined to its predecessor by `|` belongs to the same pipeline. */
function toPipelines(steps: readonly ShellStep[]): ShellStep[][] {
  const pipelines: ShellStep[][] = [];
  for (const step of steps) {
    if (step.joiner === '|' && pipelines.length > 0) pipelines[pipelines.length - 1].push(step);
    else pipelines.push([step]);
  }
  return pipelines;
}

export interface CheckCommandAnalysis {
  /** Some step of the command runs tests, lint, a build or a typecheck. */
  isCheck: boolean;
  /**
   * A non-zero exit can fairly be blamed on the check. A shell chain's exit status
   * is that of the last command that ran, so this holds only when the check is
   * what decides the status and nothing that can itself fail runs around it.
   */
  failureIsAttributable: boolean;
}

/**
 * Whether a command is a check, and whether a non-zero exit would prove the check
 * ran and failed. `npm run lint && npm test` is attributable; `git pull && npm test` is
 * not (the pull may have failed and the tests never started); `npm test | tail`
 * is not (the pipe's status is `tail`'s). The text cannot say which step failed,
 * so anything uncertain stays unattributed.
 */
export function analyzeCheckCommand(command: string | undefined): CheckCommandAnalysis {
  if (!command?.trim()) return { isCheck: false, failureIsAttributable: false };
  let isCheck = false;
  let decisive = 0;
  let uncertain = false;
  for (const stages of toPipelines(splitShellSteps(unwrapShellInvocation(command)))) {
    if (stages.some(isCheckStep)) isCheck = true;
    if (isCheckStep(stages[stages.length - 1])) decisive++;
    else if (!isHarmlessPipeline(stages)) uncertain = true;
    // With pipefail the status may belong to an earlier, non-check stage.
    if (stages.slice(0, -1).some(stage => !isCheckStep(stage) && !isHarmlessPipeline([stage]))) uncertain = true;
  }
  return { isCheck, failureIsAttributable: isCheck && decisive > 0 && !uncertain };
}

/**
 * True when a command runs tests, lint, a build or a typecheck. Looks at each
 * step of `a && b | c` on its own, so `cd app && npm test` is a check and
 * `rg test src` is not.
 */
export function isCheckCommand(command: string | undefined): boolean {
  return analyzeCheckCommand(command).isCheck;
}

// ---- A finished command ----------------------------------------------------------

/** What a provider says about how the process ended, when it says anything. */
export interface ExecutionEvidence {
  /** The provider reports the process hit its time limit. */
  timedOut?: boolean;
  /** The provider reports the signal that ended the process. */
  signal?: string | number;
}

/**
 * Read the explicit end-of-process flags a provider supplies. Grok's `rawOutput`
 * carries `signal` and `timed_out` (captured on the wire, LT-612); Cursor's
 * carries only an exit code and Codex's items carry neither, so for them this
 * finds nothing. It never looks at an exit number or at output text: a command
 * can exit with any status on purpose, and wording is not evidence.
 */
export function readExecutionEvidence(source: Record<string, unknown> | undefined): ExecutionEvidence {
  if (!source) return {};
  const signal = source['signal'];
  return {
    ...(source['timed_out'] === true || source['timedOut'] === true ? { timedOut: true } : {}),
    ...(isSignal(signal) ? { signal } : {}),
  };
}

/** A real signal: a name such as "SIGKILL" or a non-zero number. Null, empty and 0 mean none. */
function isSignal(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim() !== '')
    || (typeof value === 'number' && Number.isFinite(value) && value !== 0);
}

export interface CommandOutcomeInput extends Omit<ExecutionEvidence, 'signal'> {
  /** The signal that ended the process; null, empty and 0 (as some servers send) mean none. */
  signal?: string | number | null;
  command?: string;
  /** The process's exit status; absent or null when no process reported one. */
  exitCode?: number | null;
  /** The provider's own status for the item ("completed", "failed", "declined", …). */
  status?: string;
  /** The caller's own word on whether this was a check; wins over guessing from the command text. */
  explicitIsCheck?: boolean;
  /** An error flag the provider set itself; honoured as "could not run". */
  explicitIsError?: boolean;
}

export interface CommandOutcome {
  /** The command could not run to its own exit: never started, declined, timed out or killed. */
  isError: boolean;
  exitCode?: number;
  isCheck: boolean;
  /** A check that did not pass: it could not run, or it exited non-zero and the failure is its own. */
  checkFailed: boolean;
}

/**
 * Decide the published outcome of a finished command. A supplied exit status is
 * neutral: the command ran and chose it, whatever the number. The command "could
 * not run" only on the provider's own word: declined, failed with no exit status
 * at all, an error flag, a reported timeout or a reported signal.
 */
export function classifyCommandOutcome(input: CommandOutcomeInput): CommandOutcome {
  const exitCode = typeof input.exitCode === 'number' ? input.exitCode : undefined;
  const couldNotRun = input.explicitIsError === true
    || input.status === 'declined'
    || (input.status === 'failed' && exitCode === undefined)
    || input.timedOut === true
    || isSignal(input.signal);
  const analysis = input.explicitIsCheck === undefined
    ? analyzeCheckCommand(input.command)
    : { isCheck: input.explicitIsCheck, failureIsAttributable: input.explicitIsCheck };
  return {
    isError: couldNotRun,
    ...(exitCode === undefined ? {} : { exitCode }),
    isCheck: analysis.isCheck,
    checkFailed: analysis.isCheck
      && (couldNotRun || (exitCode !== undefined && exitCode !== 0 && analysis.failureIsAttributable)),
  };
}

/** The neutral line shown for a command that ended with this status. */
export function describeExitStatus(exitCode: number): string {
  return `Exited with status ${exitCode}`;
}

// ---- Reading a published result --------------------------------------------------

type ResultMetadata = Record<string, unknown> | undefined;

function checkDidNotPass(metadata: Record<string, unknown>): boolean {
  if (typeof metadata['checkFailed'] === 'boolean') return metadata['checkFailed'];
  const exitCode = metadata['exitCode'];
  return metadata['isCheck'] === true && typeof exitCode === 'number' && exitCode !== 0;
}

/**
 * Whether a finished tool call counts as failed under the per-kind rule. Edits
 * fail only on `is_error`; everything else also fails when it is a check that did
 * not pass (only command results ever carry the check flags, so they are honoured
 * whatever the tool is called).
 */
export function isToolResultFailed(toolName: string | undefined, metadata: ResultMetadata): boolean {
  if (!metadata) return false;
  if (metadata['is_error'] === true || metadata['isError'] === true) return true;
  return toolKindOf(toolName) !== 'edit' && checkDidNotPass(metadata);
}

/**
 * True when a command ran and exited non-zero, whatever the producer called it.
 * For readers that learn from every failed command (the correction miner) rather
 * than judge whether the turn failed.
 */
export function didCommandExitNonZero(metadata: ResultMetadata): boolean {
  const exitCode = metadata?.['exitCode'];
  return typeof exitCode === 'number' && exitCode !== 0;
}
