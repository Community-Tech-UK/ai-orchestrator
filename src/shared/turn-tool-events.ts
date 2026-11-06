/**
 * Turn tool events: one reconciled record per tool call in a turn.
 *
 * Providers describe a tool call in very different shapes. Claude sends a
 * start (`name`, `id`, `input`) and, when the main process delivers it, an
 * outcome record (`tool_use_id`, `is_error`). Codex sends a start and a result
 * that share `id`. ACP agents (Copilot, Cursor, Grok, OpenCode) key on
 * `toolCallId`, Cursor and Copilot also on `tool_use_id`, and Gemini reports a
 * failure only as an error message that names the tool. This module reads all
 * of those into one `TurnToolEvent` so the turn note, the failed-edit warning
 * and the tool group count the same things.
 *
 * Nothing here is estimated. A call whose provider never reported an outcome
 * stays `settled: false` and is never counted as failed; a line count is only
 * set when the tool input says exactly what changed.
 *
 * "Failed" is defined per tool kind (plan Step 2, used by Step 9):
 *  - an edit or write that errored;
 *  - a command that could not run (spawn failure, declined, killed), or that the
 *    provider marked as a check and that exited non-zero.
 * A command that ran and exited non-zero is not a failure by itself: `rg` finding
 * nothing exits 1. A failed read, search or other tool is not counted either.
 */

import { diffLines } from 'diff';
import { toolKindOf } from './tool-outcome';
import { turnStartKind } from './turn-start';
import type { OutputMessage } from './types/instance.types';

/** The part of an output message this module reads. */
export type ToolEventMessage = Pick<OutputMessage, 'id' | 'timestamp' | 'type' | 'content' | 'metadata'>;

export type TurnToolKind = 'edit' | 'command' | 'read' | 'search' | 'other';

export interface TurnToolEvent {
  /** Provider call id, or `msg:<message id>` when the provider gave none. */
  id: string;
  /** Id of the output message that opened this call, so a caller can place it in the transcript. */
  startMessageId: string;
  kind: TurnToolKind;
  /** The provider's tool name, as sent. */
  name: string;
  /** Files an edit wrote or a read opened, relative to the working folder when it is known. */
  paths: readonly string[];
  command?: string;
  /** True once a terminal result, outcome record or error message has been seen. */
  settled: boolean;
  /** An observed terminal outcome succeeded (cancelled and pending writes never count). */
  succeeded?: boolean;
  failed: boolean;
  /** Cleaned and truncated error text. Only set when `failed`. */
  failureText?: string;
  exitCode?: number;
  /** Exact line counts, only when the tool input says exactly what changed. */
  added?: number;
  removed?: number;
  startedAt: number;
  endedAt?: number;
}

export interface CollectToolEventsOptions {
  /** Working folder, used to show paths relative to it and to compare them. */
  cwd?: string;
}

const MAX_FAILURE_TEXT = 500;
/** Largest edit (in characters) we will line-diff in the renderer. */
const MAX_DIFF_CHARS = 200_000;

const EDIT_NAMES = new Set([
  'edit', 'multiedit', 'write', 'notebookedit', 'apply_patch', 'applypatch', 'edit_file', 'write_file',
  'editfile', 'createfile', 'create_file', 'create', 'str_replace_editor', 'replace', 'delete', 'move',
]);
const COMMAND_NAMES = new Set([
  'bash', 'shell', 'runcommand', 'run_command', 'execute', 'exec', 'local_shell', 'shell_command',
  'powershell', 'run_in_terminal', 'terminal',
]);
const READ_NAMES = new Set([
  'read', 'read_file', 'readfile', 'view', 'notebookread', 'read_many_files', 'readmanyfiles',
]);
const SEARCH_NAMES = new Set([
  'grep', 'glob', 'ls', 'listfiles', 'searchfiles', 'list_dir', 'list_directory', 'search_files',
  'search_file_content', 'websearch', 'web_search', 'webfetch', 'web_fetch', 'search', 'fetch', 'find',
]);

const FAILED_STATUSES = new Set([
  'failed', 'declined', 'error', 'errored', 'rejected', 'denied', 'timed_out', 'timeout',
]);
const TERMINAL_STATUSES = new Set([
  ...FAILED_STATUSES, 'completed', 'complete', 'success', 'succeeded', 'ok', 'done', 'cancelled', 'canceled',
]);
const PROGRESS_STATUSES = new Set(['pending', 'in_progress', 'inprogress', 'running', 'started', 'streaming']);

const ID_KEYS = ['tool_use_id', 'toolCallId', 'callId', 'id'] as const;
const NAME_KEYS = ['name', 'toolName', 'tool'] as const;
const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path', 'filename', 'file'] as const;

type Meta = Record<string, unknown>;

interface Draft {
  event: TurnToolEvent;
  nameKey: string;
  /** The start marked this call as a check (Codex tags test and lint runs `phase: 'verifying'`). */
  checkMarked: boolean;
  terminal: boolean;
  /** How many inputs had been seen when the call started, so calls of different turns stay apart. */
  epoch: number;
}

interface CollectState {
  cwd: string | undefined;
  drafts: Draft[];
  /**
   * Every call that used a given id, oldest first. Ids are only unique within a
   * run: Codex's exec mode numbers its items from zero every time, so the same
   * id turns up in many turns of one session.
   */
  byId: Map<string, Draft[]>;
  /** Inputs seen so far. */
  epoch: number;
}

/** Everything a tool start says about itself, read once per message object. */
interface StartInfo {
  id?: string;
  name: string;
  kind: TurnToolKind;
  paths: readonly string[];
  command?: string;
  added?: number;
  removed?: number;
  checkMarked: boolean;
}

/**
 * The transcript is re-read on every streamed update, and an Edit's line count
 * means diffing its strings. Messages are replaced rather than mutated, so the
 * parse is cached by message object (and working folder) and goes with the object.
 */
const startInfoCache = new WeakMap<object, { cwd: string | undefined; info: StartInfo }>();

/**
 * Decides what kind of work a tool name stands for. Unknown names are `other`.
 * Anything the shared failure rules (tool-outcome.ts) treat as an edit or a
 * command is one here too, so the turn note and the loop never disagree; the
 * sets below only add names that file does not know.
 */
export function classifyToolKind(name: string): TurnToolKind {
  const key = name.trim().toLowerCase();
  if (!key || key.startsWith('mcp__')) return 'other';
  const shared = toolKindOf(key);
  if (shared === 'edit' || shared === 'command') return shared;
  if (EDIT_NAMES.has(key)) return 'edit';
  if (COMMAND_NAMES.has(key)) return 'command';
  if (READ_NAMES.has(key)) return 'read';
  if (SEARCH_NAMES.has(key)) return 'search';
  return 'other';
}

/**
 * Tidies a tool path: forward slashes, no `.` or `..` segments, and relative to
 * the working folder when the path lies inside it. Paths outside stay absolute.
 */
export function normaliseToolPath(raw: string, cwd?: string): string {
  const value = raw.trim().replace(/\\/g, '/');
  if (!value) return '';
  const posixAbsolute = value.startsWith('/');
  const absolute = posixAbsolute || /^[A-Za-z]:\//.test(value);
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  const joined = `${posixAbsolute ? '/' : ''}${parts.join('/')}`;
  const base = cwd?.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (absolute && base && (joined === base || joined.startsWith(`${base}/`))) {
    return joined === base ? '.' : joined.slice(base.length + 1);
  }
  return joined;
}

/**
 * Reads the tool calls out of a run of output messages (normally one turn).
 * Starts are paired with results by whichever id field the provider used; a
 * start announced twice counts once; a result with no id settles the oldest open
 * call of the same tool; a result whose start was never seen still counts.
 */
export function collectTurnToolEvents(
  messages: readonly ToolEventMessage[],
  options: CollectToolEventsOptions = {},
): TurnToolEvent[] {
  const state: CollectState = { cwd: options.cwd, drafts: [], byId: new Map(), epoch: 0 };
  for (const message of messages) {
    if (turnStartKind(message)) state.epoch += 1;
    const meta: Meta = message.metadata ?? {};
    if (message.type === 'tool_use') {
      absorbStart(state, message, meta);
      // Claude's hidden outcome is patched onto its call; no extra visible result is needed.
      if (typeof meta['is_error'] === 'boolean') absorbResult(state,
        { ...message, type: 'tool_outcome', content: typeof meta['output'] === 'string' ? meta['output'] : '' }, meta);
    } else if (message.type === 'tool_result' || message.type === 'tool_outcome') {
      absorbResult(state, message, meta);
    } else if (message.type === 'error') {
      absorbError(state, message, meta);
    }
  }
  return state.drafts.map((draft) => draft.event);
}

function register(state: CollectState, draft: Draft): Draft {
  state.drafts.push(draft);
  const sameId = state.byId.get(draft.event.id);
  if (sameId) sameId.push(draft);
  else state.byId.set(draft.event.id, [draft]);
  return draft;
}

/** The call a repeated start belongs to: the newest with this id, if it is still open and from this turn. */
function openCallFromThisTurn(state: CollectState, id: string): Draft | undefined {
  const latest = state.byId.get(id)?.at(-1);
  return latest && !latest.terminal && latest.epoch === state.epoch ? latest : undefined;
}

/**
 * The call a result belongs to: the newest one with this id that is still open.
 * `known` is true when the id has been used at all, so a second copy of a
 * finished call's result can be told apart from a result whose start was missed.
 */
function openCallForResult(state: CollectState, id: string): { draft?: Draft; known: boolean } {
  const sameId = state.byId.get(id);
  if (!sameId) return { known: false };
  for (let index = sameId.length - 1; index >= 0; index -= 1) {
    if (!sameId[index].terminal) return { draft: sameId[index], known: true };
  }
  return { known: true };
}

/** For results that carry no id: the oldest open call of that tool, preferring this turn's. */
function oldestOpenCallNamed(state: CollectState, nameKey: string): Draft | undefined {
  if (!nameKey) return undefined;
  const open = state.drafts.filter((candidate) => !candidate.terminal && candidate.nameKey === nameKey);
  return open.find((candidate) => candidate.epoch === state.epoch) ?? open[0];
}

/** How many of these messages' tool calls failed, by the definition at the top of this file. */
export function countFailedToolCalls(
  messages: readonly ToolEventMessage[],
  options: CollectToolEventsOptions = {},
): number {
  return collectTurnToolEvents(messages, options).filter((event) => event.failed).length;
}

// ---------------------------------------------------------------------------
// Absorbing messages
// ---------------------------------------------------------------------------

function absorbStart(state: CollectState, message: ToolEventMessage, meta: Meta): void {
  const info = startInfoOf(message, meta, state.cwd);
  const id = info.id ?? `msg:${message.id}`;
  const existing = openCallFromThisTurn(state, id);
  if (existing) {
    // The same call announced again (a streamed start): keep the first start
    // time and fill in whatever the earlier copy lacked.
    existing.event.startedAt = Math.min(existing.event.startedAt, message.timestamp);
    existing.checkMarked ||= info.checkMarked;
    if (existing.event.paths.length === 0) existing.event.paths = info.paths;
    existing.event.command ??= info.command;
    if (existing.event.added === undefined && info.added !== undefined) {
      existing.event.added = info.added;
      existing.event.removed = info.removed;
    }
    return;
  }
  const event: TurnToolEvent = {
    id, startMessageId: message.id, kind: info.kind, name: info.name,
    paths: info.paths,
    settled: false,
    failed: false,
    startedAt: message.timestamp,
  };
  if (info.command !== undefined) event.command = info.command;
  if (info.added !== undefined) {
    event.added = info.added;
    event.removed = info.removed;
  }
  register(state, {
    event, nameKey: info.name.trim().toLowerCase(), checkMarked: info.checkMarked, terminal: false, epoch: state.epoch,
  });
}

function startInfoOf(message: ToolEventMessage, meta: Meta, cwd: string | undefined): StartInfo {
  const cached = startInfoCache.get(message);
  if (cached && cached.cwd === cwd) return cached.info;
  const name = toolNameOf(meta);
  const kind = classifyToolKind(name);
  const input = recordOf(meta['input']);
  const info: StartInfo = {
    id: callId(meta),
    name,
    kind,
    paths: extractPaths(kind, input, cwd),
    command: commandOf(input),
    checkMarked: isCheckMark(meta),
  };
  if (kind === 'edit') {
    const counts = exactLineCounts(name.trim().toLowerCase(), input);
    if (counts) {
      info.added = counts.added;
      info.removed = counts.removed;
    }
  }
  startInfoCache.set(message, { cwd, info });
  return info;
}

function absorbResult(state: CollectState, message: ToolEventMessage, meta: Meta): void {
  const id = callId(meta);
  const name = toolNameOf(meta);
  const nameKey = name.trim().toLowerCase();
  let draft: Draft | undefined;
  if (id) {
    const found = openCallForResult(state, id);
    // A second copy of the result of a call that has already finished is noise.
    if (found.known && !found.draft) return;
    draft = found.draft;
  } else {
    draft = oldestOpenCallNamed(state, nameKey);
  }
  if (!draft) {
    const kind = classifyToolKind(name);
    const event: TurnToolEvent = {
      id: id ?? `msg:${message.id}`, startMessageId: message.id, kind, name,
      paths: extractPaths(kind, recordOf(meta['input']), state.cwd),
      settled: false, failed: false, startedAt: message.timestamp,
    };
    draft = register(state, { event, nameKey, checkMarked: false, terminal: false, epoch: state.epoch });
  }

  addResultPath(draft.event, meta, state.cwd);
  // A progress copy of a result (ACP re-sends the call on every update) carries
  // no outcome. A terminal copy that has already landed is never undone by it.
  if (!isTerminalResult(message, meta) || draft.terminal) return;

  draft.terminal = true;
  draft.event.settled = true;
  draft.event.endedAt = message.timestamp;
  const exitCode = exitCodeOf(meta);
  if (exitCode !== undefined) draft.event.exitCode = exitCode;
  const failed = evaluateFailure(draft, meta);
  const status = statusOf(meta);
  draft.event.succeeded = !failed && status !== 'cancelled' && status !== 'canceled'
    && (exitCode === undefined || exitCode === 0);
  if (failed) {
    draft.event.failed = true;
    const text = cleanFailureText(message.content);
    if (text) draft.event.failureText = text;
  }
}

/**
 * Gemini reports a failed tool only as an error message that names the tool,
 * and Copilot and Cursor send one beside a failed result. The second kind must
 * not count twice, so a call that already has a result ignores it.
 */
function absorbError(state: CollectState, message: ToolEventMessage, meta: Meta): void {
  const id = callId(meta);
  const nameKey = toolNameOf(meta).trim().toLowerCase();
  const draft = id ? openCallForResult(state, id).draft : oldestOpenCallNamed(state, nameKey);
  if (!draft) return;

  draft.terminal = true;
  draft.event.settled = true;
  draft.event.endedAt = message.timestamp;
  if (draft.event.kind === 'edit' || draft.event.kind === 'command') {
    draft.event.failed = true;
    const text = cleanFailureText(message.content);
    if (text) draft.event.failureText = text;
  }
}

// ---------------------------------------------------------------------------
// Outcome rules
// ---------------------------------------------------------------------------

function isTerminalResult(message: ToolEventMessage, meta: Meta): boolean {
  if (message.type === 'tool_outcome') return true;
  const status = statusOf(meta);
  if (status !== undefined && PROGRESS_STATUSES.has(status) && typeof meta['is_error'] !== 'boolean') return false;
  if (status !== undefined && TERMINAL_STATUSES.has(status)) return true;
  // A result with no recognisable status is still a result unless it is flagged as progress.
  return status === undefined || typeof meta['is_error'] === 'boolean';
}

function evaluateFailure(draft: Draft, meta: Meta): boolean {
  const status = statusOf(meta);
  const statusFailed = status !== undefined && FAILED_STATUSES.has(status);
  const isError = meta['is_error'] === true;
  if (draft.event.kind === 'edit') return isError || statusFailed;
  if (draft.event.kind !== 'command') return false;

  const exitCode = exitCodeOf(meta);
  // Command metadata that carries `isCheck` follows the newer rule, where
  // `is_error` means only "could not run". Older metadata set `is_error` for
  // any non-zero exit, so there it only counts when no exit code was reported.
  // Either way a reported exit status is the command's own choice: the status
  // word alone ("failed" is Codex's spelling for any non-zero exit) is never
  // "could not run" once an exit code says the process ran.
  const newerMetadata = typeof meta['isCheck'] === 'boolean';
  const cannotRun = (statusFailed && exitCode === undefined)
    || (isError && (newerMetadata || exitCode === undefined));
  const isCheck = newerMetadata ? meta['isCheck'] === true : draft.checkMarked;
  // An explicit `checkFailed` is the producer's own verdict (Step 2) and wins
  // over deriving one here: a compound command's non-zero exit is not
  // necessarily its check's failure.
  const checkFailed = typeof meta['checkFailed'] === 'boolean'
    ? meta['checkFailed']
    : isCheck && exitCode !== undefined && exitCode !== 0;
  return cannotRun || checkFailed;
}

function isCheckMark(meta: Meta): boolean {
  return meta['phase'] === 'verifying' || meta['isCheck'] === true;
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function callId(meta: Meta): string | undefined {
  for (const key of ID_KEYS) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function toolNameOf(meta: Meta): string {
  for (const key of NAME_KEYS) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function statusOf(meta: Meta): string | undefined {
  const status = meta['status'];
  return typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : undefined;
}

function exitCodeOf(meta: Meta): number | undefined {
  for (const key of ['exitCode', 'exit_code']) {
    const value = meta[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function recordOf(value: unknown): Meta {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Meta : {};
}

function commandOf(input: Meta): string | undefined {
  for (const key of ['command', 'cmd']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === 'string') && value.length > 0) {
      return value.join(' ');
    }
  }
  return undefined;
}

function cleanFailureText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_FAILURE_TEXT) : undefined;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function extractPaths(kind: TurnToolKind, input: Meta, cwd: string | undefined): string[] {
  if (kind !== 'edit' && kind !== 'read') return [];
  const found: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const path = normaliseToolPath(value, cwd);
    if (path && !found.includes(path)) found.push(path);
  };
  for (const key of PATH_KEYS) push(input[key]);
  for (const key of ['changes', 'edits', 'files']) {
    const list = input[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') push(item);
      else for (const pathKey of PATH_KEYS) push(recordOf(item)[pathKey]);
    }
  }
  if (Array.isArray(input['paths'])) for (const item of input['paths']) push(item);
  const patch = input['patch'];
  if (typeof patch === 'string') for (const path of pathsFromPatch(patch)) push(path);
  return found;
}

/** Destination paths named by a unified diff (`+++ b/x`) or a Codex patch (`*** Update File: x`). */
function pathsFromPatch(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const trimmed = line.trimEnd();
    const unified = /^\+\+\+\s+(?:b\/)?(.+?)(?:\t.*)?$/.exec(trimmed);
    if (unified && unified[1] !== '/dev/null') {
      paths.push(unified[1]);
      continue;
    }
    const codex = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/.exec(trimmed);
    if (codex) paths.push(codex[1]);
  }
  return paths;
}

function addResultPath(event: TurnToolEvent, meta: Meta, cwd: string | undefined): void {
  if (event.kind !== 'edit' && event.kind !== 'read') return;
  const raw = meta['path'];
  if (typeof raw !== 'string') return;
  const path = normaliseToolPath(raw, cwd);
  // Codex reports `unknown` when it could not name the file.
  if (path && path.toLowerCase() !== 'unknown' && !event.paths.includes(path)) {
    event.paths = [...event.paths, path];
  }
}

// ---------------------------------------------------------------------------
// Exact line counts
// ---------------------------------------------------------------------------

function exactLineCounts(name: string, input: Meta): { added: number; removed: number } | undefined {
  const old = input['old_string'];
  const next = input['new_string'];
  if (typeof old === 'string' && typeof next === 'string') return replacementCounts(old, next);

  const edits = input['edits'];
  if (Array.isArray(edits) && edits.length > 0 && name === 'multiedit') {
    let added = 0;
    let removed = 0;
    for (const edit of edits) {
      const record = recordOf(edit);
      const before = record['old_string'];
      const after = record['new_string'];
      if (typeof before !== 'string' || typeof after !== 'string') return undefined;
      const counts = replacementCounts(before, after);
      if (!counts) return undefined;
      added += counts.added;
      removed += counts.removed;
    }
    return { added, removed };
  }

  const changes = input['changes'];
  if (Array.isArray(changes) && changes.length > 0) {
    let added = 0;
    let removed = 0;
    for (const change of changes) {
      const diff = recordOf(change)['diff'];
      if (typeof diff !== 'string') return undefined;
      const counts = patchCounts(diff);
      added += counts.added;
      removed += counts.removed;
    }
    return { added, removed };
  }

  const patch = input['patch'];
  if (typeof patch === 'string') return patchCounts(patch);
  return undefined;
}

function replacementCounts(before: string, after: string): { added: number; removed: number } | undefined {
  if (before.length + after.length > MAX_DIFF_CHARS) return undefined;
  let added = 0;
  let removed = 0;
  for (const hunk of diffLines(before, after)) {
    if (hunk.added) added += hunk.count ?? 0;
    else if (hunk.removed) removed += hunk.count ?? 0;
  }
  return { added, removed };
}

/** Counts `+` and `-` lines in a unified diff, leaving out the `+++`/`---` file headers. */
function patchCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}
