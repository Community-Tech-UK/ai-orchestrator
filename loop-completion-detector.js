"use strict";
/**
 * Loop Completion Detector
 *
 * Implements `plan_loop_mode.md` § B (Robust break-out detection).
 *
 * Six signals are observed; output-only claims do not stop the loop on their
 * own. When any durable sufficient signal fires, the coordinator runs the
 * configured verify command. Only when verify passes (twice, by default, to
 * guard against flakes) does the loop actually stop.
 *
 * Signals:
 *   1. completed-rename — `*_Completed.md` rename observed (watcher state)
 *   2. done-promise     — `<promise>DONE</promise>` in iteration output
 *                          (acknowledgement only; never sufficient alone)
 *   3. done-sentinel    — `DONE.txt` exists in workspace at iteration end
 *   4. all-green        — verify passes after previously-failing iteration
 *   5. self-declared    — output literal "TASK COMPLETE" / "DONE" — auxiliary
 *                          only; never sufficient alone (per spec).
 *   6. plan-checklist   — PLAN.md checkbox completion ratio = 1.0
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoopCompletionDetector = exports.CompletedFileWatcher = void 0;
exports.completedPlanFileCandidates = completedPlanFileCandidates;
const child_process_1 = require("child_process");
const fsp = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const chokidar_1 = require("chokidar");
const logger_1 = require("../logging/logger");
const loop_stage_machine_1 = require("./loop-stage-machine");
const loop_task_ledger_1 = require("./loop-task-ledger");
const logger = (0, logger_1.getLogger)('LoopCompletionDetector');
/**
 * Watches a workspace for `*_Completed.md` files. Fires `onCompleted` only on
 * NEW appearances during the run — chokidar's `ignoreInitial: true` ensures
 * pre-existing matches are not reported. This is intentional: many workspaces
 * accumulate stale `*_completed.md` plan files over time, and counting them
 * as "the agent finished this run" is a false positive that has terminated
 * loops on iteration 0 with zero tokens spent. `scanOnce()` is retained for
 * observability logging only — the coordinator uses it to log "FYI a stale
 * file is present" without seeding completion state.
 *
 * The watcher is idempotent — `start()` returns the existing watcher if
 * already running. Designed to be owned by the LoopCoordinator for the
 * duration of a single LoopState.
 */
class CompletedFileWatcher {
    workspaceCwd;
    pattern;
    additionalWatchDirs;
    watcher = null;
    observed = false;
    listeners = new Set();
    /** Listeners notified when every previously-observed completed file is gone. */
    undoneListeners = new Set();
    /** Absolute paths of completed files we've seen during the current run. */
    observedPaths = new Set();
    constructor(workspaceCwd, pattern = '*_[Cc]ompleted.md', additionalWatchDirs = []) {
        this.workspaceCwd = workspaceCwd;
        this.pattern = pattern;
        this.additionalWatchDirs = additionalWatchDirs;
    }
    isObserved() {
        return this.observed;
    }
    onCompleted(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /**
     * Subscribe to "completed file was undone" notifications. Fires when the
     * last completed-pattern file we'd observed during the run disappears
     * (rename reverted, file deleted). Allows the coordinator to clear the
     * rename observation so the rename gate is re-evaluated on the next
     * completion attempt — without this, an operator who reverts a premature
     * `_completed.md` rename couldn't reset the loop's belief that completion
     * happened.
     */
    onUndone(listener) {
        this.undoneListeners.add(listener);
        return () => this.undoneListeners.delete(listener);
    }
    /** Scan once for an existing match (e.g. immediately after restart). */
    scanOnce() {
        try {
            const re = this.globToRegex(this.pattern);
            for (const dir of this.watchTargets()) {
                const entries = fs.readdirSync(dir);
                for (const e of entries) {
                    if (re.test(e))
                        return path.join(dir, e);
                }
            }
        }
        catch (err) {
            logger.warn('CompletedFileWatcher.scanOnce failed', { error: String(err) });
        }
        return null;
    }
    start() {
        if (this.watcher)
            return;
        const re = this.globToRegex(this.pattern);
        this.watcher = (0, chokidar_1.watch)(this.watchTargets(), {
            depth: 0,
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
        });
        const fire = (filePath) => {
            const base = path.basename(filePath);
            if (!re.test(base))
                return;
            this.observed = true;
            this.observedPaths.add(filePath);
            for (const l of this.listeners) {
                try {
                    l(filePath);
                }
                catch (err) {
                    logger.warn('CompletedFileWatcher listener threw', { error: String(err) });
                }
            }
        };
        const fireUndone = (filePath) => {
            const base = path.basename(filePath);
            if (!re.test(base))
                return;
            // Only meaningful if we'd previously observed this completion. A bare
            // `unlink` event on a file we never saw doesn't represent an undo.
            if (!this.observedPaths.delete(filePath))
                return;
            // Re-scan synchronously so we don't fire on transient mid-rename
            // states. `mv a_completed.md b_completed.md` issues unlink+add; we
            // ignore the unlink because scanOnce still sees a matching file.
            if (this.scanOnce())
                return;
            this.observed = false;
            for (const l of this.undoneListeners) {
                try {
                    l(filePath);
                }
                catch (err) {
                    logger.warn('CompletedFileWatcher undone-listener threw', { error: String(err) });
                }
            }
        };
        // Listen to `add` for completion observation. A `mv X.md X_Completed.md`
        // rename is reported by chokidar as `unlink('X.md')` + `add('X_Completed.md')`,
        // so renames are covered. We deliberately do NOT listen to `change`:
        // editing a pre-existing `*_Completed.md` (e.g. appending a "what we did"
        // note) would otherwise trip completion on the edit, not on a rename.
        //
        // Listen to `unlink` to detect undo: if the operator reverts the rename
        // (or deletes the completed file), the watcher must clear observation
        // so the gate is re-evaluated. fireUndone re-scans before firing so a
        // simple in-place rename (`mv a_completed.md b_completed.md`) doesn't
        // cause a spurious undo notification.
        this.watcher.on('add', fire);
        this.watcher.on('unlink', fireUndone);
    }
    async stop() {
        if (!this.watcher)
            return;
        try {
            await this.watcher.close();
        }
        catch { /* noop */ }
        this.watcher = null;
        this.listeners.clear();
        this.undoneListeners.clear();
        this.observedPaths.clear();
    }
    globToRegex(glob) {
        // Minimal glob support: *, ?, character classes [abc] / [a-z]. Sufficient
        // for the documented patterns ("*_[Cc]ompleted.md").
        let re = '^';
        for (let i = 0; i < glob.length; i++) {
            const c = glob[i];
            if (c === '*')
                re += '[^/]*';
            else if (c === '?')
                re += '.';
            else if (c === '[') {
                let j = i + 1;
                while (j < glob.length && glob[j] !== ']')
                    j++;
                re += '[' + glob.slice(i + 1, j) + ']';
                i = j;
            }
            else if ('.+^$()|\\{}'.includes(c))
                re += '\\' + c;
            else
                re += c;
        }
        re += '$';
        return new RegExp(re);
    }
    watchTargets() {
        const workspace = path.resolve(this.workspaceCwd);
        const targets = new Set([workspace]);
        for (const dir of this.additionalWatchDirs) {
            const resolved = path.isAbsolute(dir)
                ? path.resolve(dir)
                : path.resolve(workspace, dir);
            if (!isInsideOrEqual(workspace, resolved))
                continue;
            try {
                if (fs.statSync(resolved).isDirectory())
                    targets.add(resolved);
            }
            catch {
                // Missing plan directories are harmless; the detector also has an
                // end-of-iteration filesystem fallback for configured plan files.
            }
        }
        return [...targets];
    }
}
exports.CompletedFileWatcher = CompletedFileWatcher;
class LoopCompletionDetector {
    /**
     * Inspect the just-completed iteration + workspace and return any
     * completion signals that fired. Pure (modulo file-existence checks).
     */
    async observe(input) {
        const { iteration, config, state } = input;
        const out = [];
        if (state.terminalIntentPending?.kind === 'complete' && state.terminalIntentPending.status === 'pending') {
            out.push({
                id: 'declared-complete',
                sufficient: true,
                detail: `Loop-control complete intent: ${state.terminalIntentPending.summary}`,
            });
        }
        // Textual/sentinel/checklist completion signals are only actionable when
        // the agent is actually in IMPLEMENT. A durable completed-plan rename is
        // stronger than the stage hint, though: if the configured plan file was
        // renamed and verification passes, an unnecessary follow-up iteration can
        // only turn a valid completion into a spurious provider error.
        const isImplement = iteration.stage === 'IMPLEMENT';
        // 1. *_Completed.md rename — owned by the watcher, recorded in state.
        const completedPlanFallback = state.completedFileRenameObserved
            ? null
            : await this.detectConfiguredPlanCompletedRename(config, state);
        if (completedPlanFallback) {
            state.completedFileRenameObserved = true;
        }
        if (state.completedFileRenameObserved) {
            out.push({
                id: 'completed-rename',
                sufficient: true,
                detail: completedPlanFallback
                    ? `Configured plan file was renamed during the loop: ${completedPlanFallback}`
                    : 'A *_Completed.md rename was observed during the loop',
            });
        }
        // 2. done-promise marker.
        //
        // This is deliberately NOT sufficient by itself. It is just text emitted
        // by the child process; accepting it as terminal means a single optimistic
        // final answer can end the loop with no durable workspace evidence. The
        // agent prompt requires a durable marker as well (DONE.txt, plan checklist,
        // or completed-plan rename), and those signals are what can stop the loop.
        try {
            const re = new RegExp(config.completion.donePromiseRegex, 'i');
            if (re.test(iteration.outputExcerpt)) {
                out.push({
                    id: 'done-promise',
                    sufficient: false,
                    detail: isImplement
                        ? 'Output contained <promise>DONE</promise>; waiting for durable completion evidence'
                        : 'Output contained <promise>DONE</promise>, but stage is not IMPLEMENT — ignoring',
                });
            }
        }
        catch (e) {
            logger.warn('done-promise regex invalid; skipping', { regex: config.completion.donePromiseRegex, error: String(e) });
        }
        // 3. DONE sentinel.
        //
        // Staleness guard: if the sentinel was already present at startLoop, it's
        // a leftover from a prior run, not evidence the agent finished this run.
        // The coordinator captured `state.doneSentinelPresentAtStart` once at
        // boot — we only fire when the sentinel is currently present AND was
        // absent at start. (Edits to a pre-existing sentinel mid-run are
        // intentionally not treated as evidence; the agent should delete and
        // re-create it if they really mean a fresh signal.)
        if (config.completion.doneSentinelFile && !state.doneSentinelPresentAtStart) {
            const sentinel = path.resolve(config.workspaceCwd, config.completion.doneSentinelFile);
            try {
                await fsp.access(sentinel);
                out.push({
                    id: 'done-sentinel',
                    sufficient: isImplement,
                    detail: isImplement
                        ? `Sentinel file created during run: ${config.completion.doneSentinelFile}`
                        : `Sentinel file created during run: ${config.completion.doneSentinelFile}, but stage is not IMPLEMENT — ignoring`,
                });
            }
            catch {
                // not present — fine
            }
        }
        // 5. self-declared (auxiliary, never sufficient)
        if (/\bTASK COMPLETE\b|\bDONE\b/i.test(iteration.outputExcerpt)) {
            out.push({
                id: 'self-declared',
                sufficient: false,
                detail: 'Output mentions TASK COMPLETE / DONE',
            });
        }
        // 6. plan-checklist 100%.
        //
        // Staleness guard: if the planFile was already fully ticked at startLoop
        // (e.g. someone committed a "done" plan and started a new loop on top
        // of it), that's not evidence the agent finished this run. We only fire
        // when the checklist transitions from "had unchecked items" → "fully
        // checked" during the run. `state.planChecklistFullyCheckedAtStart` is
        // captured once by `LoopStageMachine.captureStartupSnapshot` at boot;
        // we use the same `parsePlanChecklist` function here so the runtime
        // measurement matches the baseline measurement exactly.
        if (config.planFile && !state.planChecklistFullyCheckedAtStart) {
            const planPath = path.resolve(config.workspaceCwd, config.planFile);
            try {
                const text = await fsp.readFile(planPath, 'utf8');
                const { checked, fullyChecked } = (0, loop_stage_machine_1.parsePlanChecklist)(text);
                if (fullyChecked) {
                    out.push({
                        id: 'plan-checklist',
                        sufficient: isImplement,
                        detail: isImplement
                            ? `All ${checked} checklist items in ${config.planFile} were checked during this run`
                            : `All ${checked} checklist items in ${config.planFile} were checked during this run, but stage is not IMPLEMENT — ignoring`,
                    });
                }
            }
            catch {
                // plan file missing or unreadable — fine
            }
        }
        // 7. LF-4: structured task ledger (LOOP_TASKS.md) — the per-item source of
        //    truth for stopping. When the ledger has items it is the AUTHORITY:
        //    while any item is open (todo/doing) NO completion signal is sufficient
        //    (a premature DONE.txt / declared-complete can't stop a half-done run);
        //    once every item is done/deferred, `ledger-complete` is the stop signal
        //    (subject to verify-before-stop). A pre-resolved ledger from a prior run
        //    is ignored (staleness guard), and an empty ledger (no items) is a no-op.
        try {
            const ledgerText = await fsp.readFile(path.resolve(config.workspaceCwd, loop_stage_machine_1.LOOP_TASKS_FILE), 'utf8');
            const ledger = (0, loop_task_ledger_1.parseTaskLedger)(ledgerText);
            if (ledger.total > 0) {
                if (ledger.complete) {
                    if (!state.loopTasksLedgerResolvedAtStart) {
                        out.push({
                            id: 'ledger-complete',
                            sufficient: isImplement,
                            detail: isImplement
                                ? `All ${ledger.total} ${loop_stage_machine_1.LOOP_TASKS_FILE} items resolved (done/deferred) during this run`
                                : `All ${ledger.total} ${loop_stage_machine_1.LOOP_TASKS_FILE} items resolved, but stage is not IMPLEMENT — ignoring`,
                        });
                    }
                }
                else {
                    // Open items remain → the ledger blocks completion. Demote every
                    // other signal so the loop keeps working the ledger, and record why.
                    const open = ledger.total - ledger.resolved;
                    for (const evidence of out)
                        evidence.sufficient = false;
                    out.push({
                        id: 'ledger-complete',
                        sufficient: false,
                        detail: `${loop_stage_machine_1.LOOP_TASKS_FILE} has ${open} open item(s)` +
                            (ledger.nextTodo ? ` — next: ${ledger.nextTodo}` : '') +
                            ' — completion blocked until every item is done or deferred (with a reason)',
                    });
                }
            }
        }
        catch {
            // No LOOP_TASKS.md (or unreadable) — ledger inactive, no effect.
        }
        return out;
    }
    /**
     * Run the configured verify command. Returns passed/failed with output.
     * Times out per `config.completion.verifyTimeoutMs`.
     */
    async runVerify(config) {
        const cmd = (config.completion.verifyCommand || '').trim();
        if (!cmd) {
            // No command => the loop has NOT verified anything. Returning 'passed'
            // here would make the completion gate a rubber stamp: a self-declared
            // "done" would stop the loop with zero independent evidence. Report a
            // distinct 'skipped' so the coordinator refuses to stop on it.
            return { status: 'skipped', output: '(no verify command configured)', durationMs: 0 };
        }
        return this.spawnVerify(cmd, config.workspaceCwd, config.completion.verifyTimeoutMs, 'verify');
    }
    /**
     * FU-6: run an optional cheap pre-flight verify before the full
     * `verifyCommand`. Returns:
     *  - 'skipped' when no quickVerifyCommand is configured (callers should
     *    proceed directly to runVerify);
     *  - 'passed' when the cheap command exits zero;
     *  - 'failed' when the cheap command exits non-zero or times out.
     *
     * A failed quick-verify lets the coordinator reject completion without
     * spending the (typically minutes-long) full verify on a known-failing
     * change.
     */
    async runQuickVerify(config) {
        const cmd = (config.completion.quickVerifyCommand || '').trim();
        if (!cmd) {
            return { status: 'skipped', output: '(no quick verify command configured)', durationMs: 0 };
        }
        const timeout = config.completion.quickVerifyTimeoutMs ?? 120_000;
        return this.spawnVerify(cmd, config.workspaceCwd, timeout, 'quick-verify');
    }
    spawnVerify(cmd, workspaceCwd, timeoutMs, label) {
        const started = Date.now();
        return new Promise((resolve) => {
            const child = (0, child_process_1.spawn)(cmd, [], {
                cwd: workspaceCwd,
                shell: true,
                env: { ...process.env, CI: '1' },
            });
            let stdout = '';
            let stderr = '';
            const cap = (chunk, target) => {
                const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                if (target === 'stdout') {
                    stdout += s;
                    if (stdout.length > 200_000)
                        stdout = stdout.slice(-200_000);
                }
                else {
                    stderr += s;
                    if (stderr.length > 200_000)
                        stderr = stderr.slice(-200_000);
                }
            };
            child.stdout?.on('data', (b) => cap(b, 'stdout'));
            child.stderr?.on('data', (b) => cap(b, 'stderr'));
            const to = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch { /* noop */ }
                resolve({
                    status: 'failed',
                    output: `${stdout}\n${stderr}\n(${label} timed out after ${timeoutMs}ms)`,
                    durationMs: Date.now() - started,
                    exitCode: null,
                });
            }, timeoutMs);
            child.on('close', (code) => {
                clearTimeout(to);
                const output = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
                if (code === 0) {
                    resolve({ status: 'passed', output, durationMs: Date.now() - started });
                }
                else {
                    resolve({ status: 'failed', output, durationMs: Date.now() - started, exitCode: code });
                }
            });
            child.on('error', (err) => {
                clearTimeout(to);
                resolve({
                    status: 'failed',
                    output: `${label} command failed to spawn: ${err.message}`,
                    durationMs: Date.now() - started,
                    exitCode: null,
                });
            });
        });
    }
    /**
     * Look at fired signals and decide whether ANY are "sufficient" to trigger
     * verify-before-stop.
     */
    hasSufficientSignal(evidences) {
        return evidences.some((e) => e.sufficient);
    }
    /**
     * Belt-and-braces gate. When completed-file enforcement is enabled,
     * completion isn't accepted until a *_Completed.md rename has actually
     * happened during this run. General continuation loops leave this off
     * because there may be no plan file to rename.
     */
    passesBeltAndBraces(state, config) {
        if (!config.completion.requireCompletedFileRename)
            return true;
        return state.completedFileRenameObserved;
    }
    async detectConfiguredPlanCompletedRename(config, state) {
        if (!config.planFile)
            return null;
        const workspace = path.resolve(config.workspaceCwd);
        const original = path.resolve(workspace, config.planFile);
        if (!isInsideOrEqual(workspace, original))
            return null;
        if (await pathExists(original))
            return null;
        for (const candidate of completedPlanFileCandidates(config)) {
            try {
                const stat = await fsp.stat(candidate);
                if (!stat.isFile())
                    continue;
                const newestFileTimestamp = Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs);
                // Guard against stale completed files that predate this loop. Rename
                // updates ctime even when mtime is preserved, so this still catches a
                // real in-run `mv old.md old_completed.md`.
                if (state.startedAt > 0 && newestFileTimestamp + 2_000 < state.startedAt) {
                    continue;
                }
                const actualPath = await resolveActualPathCase(candidate);
                return path.relative(workspace, actualPath) || path.basename(actualPath);
            }
            catch {
                // candidate absent — try the next casing
            }
        }
        return null;
    }
}
exports.LoopCompletionDetector = LoopCompletionDetector;
function completedPlanFileCandidates(config) {
    if (!config.planFile)
        return [];
    const workspace = path.resolve(config.workspaceCwd);
    const original = path.resolve(workspace, config.planFile);
    if (!isInsideOrEqual(workspace, original))
        return [];
    const ext = path.extname(original);
    if (ext.toLowerCase() !== '.md')
        return [];
    const stem = original.slice(0, -ext.length);
    return [...new Set([`${stem}_Completed.md`, `${stem}_completed.md`])];
}
function isInsideOrEqual(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
async function pathExists(target) {
    try {
        await fsp.access(target);
        return true;
    }
    catch {
        return false;
    }
}
async function resolveActualPathCase(target) {
    const dir = path.dirname(target);
    const base = path.basename(target);
    try {
        const entries = await fsp.readdir(dir);
        const exact = entries.find((entry) => entry === base);
        if (exact)
            return path.join(dir, exact);
        const insensitive = entries.find((entry) => entry.toLowerCase() === base.toLowerCase());
        if (insensitive)
            return path.join(dir, insensitive);
    }
    catch {
        // Fall back to the candidate path if the directory cannot be read.
    }
    return target;
}
//# sourceMappingURL=loop-completion-detector.js.map