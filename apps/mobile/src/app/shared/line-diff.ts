/**
 * Minimal line diff for the mobile approval card: turns an Edit tool's
 * old_string/new_string (or a Write tool's content) into unified-diff rows the
 * phone can render with +/− colouring. LCS-based, capped so a pathological
 * input can't lock up the UI thread.
 */

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'skip';
  text: string;
}

export interface LineDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when either side was cut at {@link MAX_LINES} before diffing. */
  truncated: boolean;
}

/** Lines per side before we stop diffing and truncate (keeps DP ~90k cells). */
const MAX_LINES = 300;
/** Unchanged runs longer than this collapse to a "⋯ N unchanged" row. */
const CTX_KEEP = 3;

export function diffLines(oldText: string, newText: string): LineDiff {
  const oldAll = splitLines(oldText);
  const newAll = splitLines(newText);
  const truncated = oldAll.length > MAX_LINES || newAll.length > MAX_LINES;
  const a = oldAll.slice(0, MAX_LINES);
  const b = newAll.slice(0, MAX_LINES);

  const raw = lcsDiff(a, b);
  const rows = collapseContext(raw);
  let added = 0;
  let removed = 0;
  for (const row of raw) {
    if (row.kind === 'add') added++;
    if (row.kind === 'del') removed++;
  }
  return { rows, added, removed, truncated };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\n$/, '').split('\n');
}

/** Classic LCS walk producing del/add/ctx rows in order. */
function lcsDiff(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++] });
  while (j < m) rows.push({ kind: 'add', text: b[j++] });
  return rows;
}

/** Keep {@link CTX_KEEP} unchanged lines around each change; fold the rest. */
function collapseContext(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffRow[] = [];

  const flush = (isEdge: boolean): void => {
    if (run.length === 0) return;
    const keepHead = out.length === 0 ? 0 : CTX_KEEP;
    const keepTail = isEdge ? 0 : CTX_KEEP;
    if (run.length <= keepHead + keepTail + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, keepHead));
      out.push({ kind: 'skip', text: `⋯ ${run.length - keepHead - keepTail} unchanged lines` });
      if (keepTail > 0) out.push(...run.slice(run.length - keepTail));
    }
    run = [];
  };

  for (const row of rows) {
    if (row.kind === 'ctx') {
      run.push(row);
    } else {
      flush(false);
      out.push(row);
    }
  }
  flush(true);
  return out;
}
