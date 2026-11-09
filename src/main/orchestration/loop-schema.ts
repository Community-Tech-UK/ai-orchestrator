/**
 * Loop Mode SQLite Schema + Migrations
 *
 * Two tables: `loop_runs` (one row per loop) and `loop_iterations` (one row
 * per iteration). The migration runner pattern matches
 * `conversation-ledger-schema.ts` so that ops folks have one mental model.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { PLAN_QUEUE_MIGRATIONS } from '../plan-queue/plan-queue-migrations';
import { addPlanQueueSections } from '../plan-queue/plan-queue-section-migration';

export const LOOP_SCHEMA_VERSION = 54;

export interface LoopMigration {
  version: number;
  name: string;
  up: string | ((db: SqliteDriver) => void);
}

/**
 * Every loop-database migration, in the order they run. Exported read-only so a test can check
 * versions and names are unique and increasing. Versions that have run on a real database are
 * never renumbered; see `PLAN_QUEUE_RESERVED_MIGRATIONS` for the numbers held for later queue work.
 */
export const LOOP_MIGRATIONS: readonly LoopMigration[] = [
  {
    version: 1,
    name: '001_initial_loop_runs',
    up: `
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        plan_file TEXT,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        total_iterations INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_cents INTEGER NOT NULL DEFAULT 0,
        current_stage TEXT,
        completed_file_rename_observed INTEGER NOT NULL DEFAULT 0,
        highest_test_pass_count INTEGER NOT NULL DEFAULT 0,
        end_reason TEXT,
        end_evidence_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_loop_runs_chat
        ON loop_runs(chat_id, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_loop_runs_status
        ON loop_runs(status, started_at DESC);

      CREATE TABLE IF NOT EXISTS loop_iterations (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        stage TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        child_instance_id TEXT,
        tokens INTEGER NOT NULL DEFAULT 0,
        cost_cents INTEGER NOT NULL DEFAULT 0,
        files_changed_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]',
        test_pass_count INTEGER,
        test_fail_count INTEGER,
        work_hash TEXT NOT NULL,
        output_similarity_to_prev REAL,
        output_excerpt TEXT NOT NULL DEFAULT '',
        progress_verdict TEXT NOT NULL,
        progress_signals_json TEXT NOT NULL DEFAULT '[]',
        completion_signals_fired_json TEXT NOT NULL DEFAULT '[]',
        verify_status TEXT NOT NULL,
        verify_output_excerpt TEXT NOT NULL DEFAULT ''
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_iterations_run_seq
        ON loop_iterations(loop_run_id, seq);

      CREATE INDEX IF NOT EXISTS idx_loop_iterations_run_started
        ON loop_iterations(loop_run_id, started_at DESC);
    `,
  },
  {
    version: 2,
    name: '002_loop_terminal_intents',
    up: `
      CREATE TABLE IF NOT EXISTS loop_terminal_intents (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        iteration_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        status_reason TEXT,
        file_path TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_loop_terminal_intents_run
        ON loop_terminal_intents(loop_run_id, received_at DESC);

      CREATE INDEX IF NOT EXISTS idx_loop_terminal_intents_status
        ON loop_terminal_intents(status, received_at DESC);
    `,
  },
  {
    // FU-3: persist a per-run restart-failure counter so the boot-time
    // interrupt handler can detect loops that crash on every restart
    // (each boot interrupt without intervening successful iteration
    // bumps the count). When the counter crosses a threshold the loop
    // is marked `failed` with reason `crash-loop` instead of being
    // restored to `paused`, preventing an infinite restart spiral.
    version: 3,
    name: '003_loop_runs_restart_failure_count',
    up: `
      ALTER TABLE loop_runs ADD COLUMN restart_failure_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // FU-2 persistence: store the manual-review flag so a rehydrated
    // paused loop keeps its "no verify command" semantics through an
    // app restart. Without this, on a future resume-from-DB path the
    // Zod schema's `.default(false)` would lie about the loop's
    // configuration and the agent's prompt would no longer warn about
    // manual review.
    version: 4,
    name: '004_loop_runs_manual_review_only',
    up: `
      ALTER TABLE loop_runs ADD COLUMN manual_review_only INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Outstanding-items capture: when a loop terminates, the structured
    // OUTSTANDING.md sections (Needs human / Open questions) are persisted as
    // individual rows here so the human-gated work survives the chat scroll-back
    // and can be aggregated per workspace + marked resolved/dismissed in the UI.
    // The id is a deterministic sha256(loopRunId|kind|text) so re-capturing the
    // same run upserts (preserving any user-set status) instead of duplicating.
    version: 5,
    name: '005_loop_outstanding_items',
    up: `
      CREATE TABLE IF NOT EXISTS loop_outstanding_items (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        workspace_cwd TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        loop_status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_loop_outstanding_workspace
        ON loop_outstanding_items(workspace_cwd, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_loop_outstanding_run
        ON loop_outstanding_items(loop_run_id);
    `,
  },
  {
    version: 6,
    name: '006_loop_checkpoints',
    up: `
      CREATE TABLE IF NOT EXISTS loop_checkpoints (
        loop_run_id TEXT PRIMARY KEY REFERENCES loop_runs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        history_tail_json TEXT NOT NULL,
        convergence_note TEXT,
        plan_regeneration_count INTEGER NOT NULL DEFAULT 0,
        pending_context_reset INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_loop_checkpoints_status_updated
        ON loop_checkpoints(status, updated_at DESC);
    `,
  },
  {
    // Campaign mode: a campaign is a DAG of loop specs. Each node is a
    // standard loop run; edges define sequencing and gating. Persisted
    // so campaigns survive app restart and resume from the last known state.
    version: 7,
    name: '007_campaigns',
    up: `
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        paused_reason TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_campaigns_status
        ON campaigns(status, started_at DESC);

      CREATE TABLE IF NOT EXISTS campaign_nodes (
        node_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        loop_run_id TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        skipped_reason TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, node_id)
      );

      CREATE INDEX IF NOT EXISTS idx_campaign_nodes_campaign
        ON campaign_nodes(campaign_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_campaign_nodes_loop_run
        ON campaign_nodes(loop_run_id);
    `,
  },
  {
    // Human answer capture: let the operator record a decision/answer against an
    // outstanding item (the "Needs human" / "Open questions" the loop flagged)
    // instead of only marking it resolved/dismissed. The answer survives status
    // changes (resolve preserves it) and is surfaced in the panel + the exported
    // OUTSTANDING.md, and is the input Slice 2 feeds back into a continuation.
    version: 8,
    name: '008_loop_outstanding_user_response',
    up: `
      ALTER TABLE loop_outstanding_items ADD COLUMN user_response TEXT;
    `,
  },
  {
    // P3 worktree isolation registry: record the per-session worktree path and
    // branch name so boot-reconcile can adopt or reap orphaned worktrees after a
    // crash. Both columns are nullable — pre-isolation runs have no worktree.
    version: 9,
    name: '009_loop_runs_worktree_columns',
    up: `
      ALTER TABLE loop_runs ADD COLUMN worktree_path TEXT;
      ALTER TABLE loop_runs ADD COLUMN branch_name TEXT;
    `,
  },
  {
    // Persist the agent's complete closing message per iteration, distinct from
    // the tiny head+tail `output_excerpt` that drives similarity/no-progress/
    // completion detection. The summary card, trace inspector, and chat recap
    // render this so the user can read the full final response instead of the
    // 4 KB detection excerpt. Existing rows backfill to '' via the column
    // default; new iterations write the bounded full output.
    version: 10,
    name: '010_loop_iterations_output_full',
    up: `
      ALTER TABLE loop_iterations ADD COLUMN output_full TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // Agent-authored recommendation per outstanding item: the loop agent (which
    // just did the work, with full context) writes a one-line recommended
    // decision/next-step as a `Recommendation:` sub-bullet under each Needs-human
    // / Open-question item. Persisted here so the Outstanding panel can pre-fill
    // the answer box with a concrete suggestion instead of a blank field. It is a
    // suggestion only — surfaced as an editable draft, never auto-accepted as the
    // human's answer. Nullable: items without a recommendation (and pre-existing
    // rows) backfill to NULL.
    version: 11,
    name: '011_loop_outstanding_recommended_answer',
    up: `
      ALTER TABLE loop_outstanding_items ADD COLUMN recommended_answer TEXT;
    `,
  },
  {
    // Persist the final audit result attached to the sealed iteration. The live
    // coordinator mutates LoopIteration.finalAudit after running the completion
    // audit; storing the JSON here keeps history, pagination, and restart
    // recovery aligned with the contract schema.
    version: 12,
    name: '012_loop_iterations_final_audit',
    up: `
      ALTER TABLE loop_iterations ADD COLUMN final_audit_json TEXT;
    `,
  },
  {
    // Distinguish real red verify commands from verifier infrastructure faults.
    // `verify_status` remains the broad pass/fail UI state; this optional
    // reason lets history and recovery explain whether the command exited
    // non-zero, timed out, or failed to spawn.
    version: 13,
    name: '013_loop_iterations_verify_failure_kind',
    up: `
      ALTER TABLE loop_iterations ADD COLUMN verify_failure_kind TEXT;
    `,
  },
  {
    // Scheduled wakeups are terminal-control intents that pause the loop until a
    // requested re-entry time. Persist the requested epoch-ms timestamp so the
    // recovered intent history can explain when the wakeup was meant to resume.
    version: 14,
    name: '014_loop_terminal_intents_resume_at',
    up: `
      ALTER TABLE loop_terminal_intents ADD COLUMN resume_at INTEGER;
    `,
  },
  {
    // Loop spend was previously stored as a single `cost_cents` with no way to
    // tell a provider-reported dollar figure from an estimate, and no cache
    // split at all. That made ~97% of measured spend un-auditable: the legacy
    // fallback priced `tokens` (which INCLUDES cache reads, billed at ~10% of
    // the input rate) at a flat $15/Mtok, overstating cost ~2.75x.
    //
    // `model` + the cache columns let cost be re-derived per-model via
    // `computeTokenCost`; `cost_known` marks rows whose cost the provider
    // actually reported. All nullable — pre-existing rows keep NULL and are
    // correctly treated as "unknown", not "zero".
    version: 15,
    name: '015_loop_iterations_cache_tokens',
    up: `
      ALTER TABLE loop_iterations ADD COLUMN cache_read_tokens INTEGER;
      ALTER TABLE loop_iterations ADD COLUMN cache_write_tokens INTEGER;
      ALTER TABLE loop_iterations ADD COLUMN model TEXT;
      ALTER TABLE loop_iterations ADD COLUMN cost_known INTEGER;
    `,
  },
  {
    // Durable managed-worktree finalization state. Kept as JSON because the
    // phase and branch/error metadata are read and written atomically.
    version: 16,
    name: '016_loop_runs_worktree_lifecycle',
    up: `
      ALTER TABLE loop_runs ADD COLUMN worktree_lifecycle_json TEXT;
    `,
  },
  {
    // Plan Queue: one worker instance per plan/livetest document, judged by a
    // separate verifier. `plan_queue_items` owns each item's worktree — branch
    // and path are written here BEFORE the worktree is created, so ownership
    // survives a restart (WorktreeManager.sessions is in-memory only).
    version: 17,
    name: '017_plan_queue',
    up: `
      CREATE TABLE IF NOT EXISTS plan_queue_runs (
        id TEXT PRIMARY KEY,
        parent_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        workspace_cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        relaxation_json TEXT,
        worker_provider TEXT,
        worker_model TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plan_queue_runs_status
        ON plan_queue_runs(status, started_at DESC);

      CREATE TABLE IF NOT EXISTS plan_queue_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES plan_queue_runs(id) ON DELETE CASCADE,
        document_path TEXT NOT NULL,
        state TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        errored_rounds INTEGER NOT NULL DEFAULT 0,
        branch_name TEXT,
        worktree_path TEXT,
        base_commit TEXT,
        checkpoint_commit TEXT,
        verified_main_commit TEXT,
        landed_commit TEXT,
        worker_instance_id TEXT,
        verifier_instance_id TEXT,
        question_json TEXT,
        answer TEXT,
        park_reason TEXT,
        detail TEXT,
        verdict_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, document_path)
      );

      CREATE INDEX IF NOT EXISTS idx_plan_queue_items_run
        ON plan_queue_items(run_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_plan_queue_items_state
        ON plan_queue_items(state);
    `,
  },
  {
    // Plan Queue: landing refusals (pre-commit hook or active documents) since
    // the item last landed or parked. Persisted so "the second refusal parks"
    // holds across an app restart.
    version: 18,
    name: '018_plan_queue_landing_refusals',
    up: `
      ALTER TABLE plan_queue_items ADD COLUMN landing_refusals INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Campaign `isolation: 'worktree'` nodes land their worktree back into the
    // repository like a managed loop does. The checkout path and lifecycle are
    // persisted before any Git mutation so boot recovery can finish a landing.
    version: 19,
    name: '019_campaign_nodes_worktree_lifecycle',
    up: `
      ALTER TABLE campaign_nodes ADD COLUMN worktree_path TEXT;
      ALTER TABLE campaign_nodes ADD COLUMN worktree_lifecycle_json TEXT;
    `,
  },
  {
    version: 20,
    name: '020_plan_queue_runs_parent_thread',
    up: `ALTER TABLE plan_queue_runs ADD COLUMN parent_history_thread_id TEXT;`,
  },
  {
    version: 21,
    name: '021_loop_spend_and_round_telemetry',
    up: `
      ALTER TABLE loop_iterations ADD COLUMN finish_reason TEXT;
      ALTER TABLE loop_iterations ADD COLUMN prompt_bytes INTEGER;
      CREATE TABLE IF NOT EXISTS loop_run_spend (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        iteration_seq INTEGER, purpose TEXT NOT NULL, detail TEXT, provider TEXT, model TEXT,
        tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        cost_cents INTEGER NOT NULL DEFAULT 0, basis TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loop_run_spend_run ON loop_run_spend(loop_run_id, created_at);
      ALTER TABLE plan_queue_items ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plan_queue_items ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE plan_queue_items ADD COLUMN exact_cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE plan_queue_runs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plan_queue_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE plan_queue_runs ADD COLUMN exact_cost_usd REAL NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 22,
    name: '022_loop_live_questions',
    up: `
      ALTER TABLE loop_outstanding_items ADD COLUMN risk_class TEXT;
      ALTER TABLE loop_outstanding_items ADD COLUMN first_seen_round INTEGER;
      ALTER TABLE loop_outstanding_items ADD COLUMN outcome TEXT;
      ALTER TABLE loop_outstanding_items ADD COLUMN answer_sent_at INTEGER;
    `,
  },
  {
    version: 23,
    name: '023_plan_queue_holds',
    up: `
      ALTER TABLE plan_queue_items ADD COLUMN held_at INTEGER;
      ALTER TABLE plan_queue_items ADD COLUMN pending_instruction TEXT;
    `,
  },
  {
    // Plan Queue: workers come from a ranked list, so a run's first choice is
    // not necessarily what an item's worker ran on. The checker is chosen
    // against these even after that session is gone.
    version: 24,
    name: '024_plan_queue_item_worker_route',
    up: `
      ALTER TABLE plan_queue_items ADD COLUMN worker_provider TEXT;
      ALTER TABLE plan_queue_items ADD COLUMN worker_model TEXT;
    `,
  },
  {
    // Plan Queue: a document whose worker failed every check is handed to the
    // run's step-up worker once. Recorded before that worker starts, so every
    // later session for it (respawn, restart, Resume) keeps the step-up choice
    // and the document is never handed over twice.
    version: 25,
    name: '025_plan_queue_item_step_up',
    up: `
      ALTER TABLE plan_queue_items ADD COLUMN stepped_up_at INTEGER;
    `,
  },
  {
    // Plan Queue: the provider conversation a worker last ran in, so a replacement on the same
    // route can continue it. Versions 26–29 were reserved for queue branches but none used them, so
    // they stay unused: this entry already ran on real databases and is never renumbered.
    version: 30,
    name: '030_plan_queue_item_worker_session',
    up: `ALTER TABLE plan_queue_items ADD COLUMN worker_session_json TEXT;`,
  },
  ...PLAN_QUEUE_MIGRATIONS,
  {
    // Plan Queue: the debugging port a livetest item's dev app uses, checked free when its worker
    // starts and kept so a restart or resume reuses it. A local build recorded this column at version 31
    // before Phase C took 31 for its history tables, so this entry adopts that column when it is already there.
    version: 40,
    name: '040_plan_queue_item_livetest_port',
    up: (db) => {
      const existing = db.prepare('PRAGMA table_info(plan_queue_items)').all<{ name: string; type: string; notnull: number }>()
        .find(column => column.name === 'livetest_port');
      if (!existing) {
        db.exec('ALTER TABLE plan_queue_items ADD COLUMN livetest_port INTEGER;');
        return;
      }
      const legacy = db.prepare('SELECT name FROM loop_migrations WHERE version = 31').get<{ name: string }>();
      if (legacy?.name !== '031_plan_queue_item_livetest_port' || existing.type !== 'INTEGER' || existing.notnull !== 0) {
        throw new Error('The existing livetest_port column does not match the legacy queue migration');
      }
    },
  },
  {
    // Plan Queue: returns to the worker for a base-branch conflict or a failed post-merge check, so the
    // loop can be limited and the count survives a restart.
    version: 41,
    name: '041_plan_queue_item_base_conflicts',
    up: `ALTER TABLE plan_queue_items ADD COLUMN base_conflicts INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // A local pre-Phase-C build recorded the port at version 31. Preserve that receipt and repair
    // the history schema its version caused the runner to skip, including already-upgraded profiles.
    version: 42,
    name: '042_plan_queue_legacy_history',
    up: `
      CREATE TABLE IF NOT EXISTS plan_queue_item_events (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES plan_queue_items(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, at INTEGER NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
        reason TEXT, detail_head TEXT, round INTEGER NOT NULL, tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queue_events_item ON plan_queue_item_events(item_id, at);
      CREATE TABLE IF NOT EXISTS plan_queue_verdicts (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES plan_queue_items(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, round INTEGER NOT NULL, at INTEGER NOT NULL, verdict TEXT NOT NULL,
        findings_json TEXT NOT NULL, gates_json TEXT NOT NULL, not_checked_json TEXT NOT NULL,
        worktree_head TEXT, document_sha256 TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queue_verdicts_item ON plan_queue_verdicts(item_id, at);
      CREATE INDEX IF NOT EXISTS idx_queue_parked_doc ON plan_queue_items(document_path, state, updated_at DESC);
      CREATE TABLE IF NOT EXISTS plan_queue_item_pins (
        item_id TEXT PRIMARY KEY REFERENCES plan_queue_items(id) ON DELETE CASCADE,
        document_sha256 TEXT NOT NULL, document_bytes INTEGER NOT NULL,
        unchecked_json TEXT NOT NULL, recorded_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_queue_triage_decisions (
        document_sha256 TEXT PRIMARY KEY, decision_json TEXT NOT NULL, decided_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Plan Queue: the worker's completion report (`plan_queue_report_ready`), stored as JSON on the item row.
    version: 43,
    name: '043_plan_queue_item_worker_report',
    up: `ALTER TABLE plan_queue_items ADD COLUMN worker_report_json TEXT;`,
  },
  {
    // Plan Queue: where an item's work comes from and the order a run works its items in (step 6.2 of the
    // autonomy-and-Linear programme). Plain ADD COLUMN, so `plan_queue_items` is not rebuilt by this migration: the
    // `document_path` column stays, and now holds the source reference (the absolute path for markdown). Migration
    // 54 rebuilds the table from its live columns, so it keeps these two. Existing rows are markdown with an empty sort key, which sorts first and in
    // `created_at` order, the order they always had. Landed after 45 on a database that already had 45 to 52: the
    // runner applies by version, so the number held for it still works.
    version: 44,
    name: '044_plan_queue_item_source_sort',
    up: `
      ALTER TABLE plan_queue_items ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'markdown';
      ALTER TABLE plan_queue_items ADD COLUMN sort_key TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // Plan Queue: a landing blocked by the root checkout's uncommitted code waits instead of parking.
    version: 45,
    name: '045_plan_queue_item_landing_wait',
    up: `
      ALTER TABLE plan_queue_items ADD COLUMN landing_wait_since INTEGER;
      ALTER TABLE plan_queue_items ADD COLUMN landing_wait_paths TEXT;
    `,
  },
  {
    // Plan Queue: Discard was recorded as a sentence at the end of `detail`, which any later save could
    // lose, bringing the job back. Earlier discards move to these fields; `discard_ref_expires_at`
    // stays empty for them until the hourly sweep finds a kept reference. Held numbers below this one
    // (PLAN_QUEUE_RESERVED_MIGRATIONS) go before this entry when they land, so the list stays in order.
    version: 50,
    name: '050_plan_queue_item_discard',
    up: (db) => {
      db.exec(`
        ALTER TABLE plan_queue_items ADD COLUMN discarded_at INTEGER;
        ALTER TABLE plan_queue_items ADD COLUMN discarded_by TEXT;
        ALTER TABLE plan_queue_items ADD COLUMN discard_ref_expires_at INTEGER;
      `);
      const update = db.prepare('UPDATE plan_queue_items SET discarded_at = ?, discarded_by = ?, detail = ? WHERE id = ?');
      const rows = db.prepare(`
        SELECT id, detail, updated_at FROM plan_queue_items
        WHERE branch_name IS NULL AND worktree_path IS NULL AND detail LIKE '%Discarded by %'
      `).all<{ id: string; detail: string; updated_at: number }>();
      for (const row of rows) {
        const receipt = /(?:^|\s)Discarded by ([^\n]+)\.$/.exec(row.detail);
        if (receipt) update.run(row.updated_at, receipt[1], row.detail.slice(0, receipt.index).trim() || null, row.id);
      }
    },
  },
  {
    // Plan Queue: why a run has stopped starting new work after a shared failure. Stored so it survives a restart.
    version: 51,
    name: '051_plan_queue_run_hold_reason',
    up: `ALTER TABLE plan_queue_runs ADD COLUMN hold_reason TEXT;`,
  },
  {
    // Plan Queue: a landing Harness retried by itself, which must never start a worker turn, even after a restart.
    version: 52,
    name: '052_plan_queue_item_landing_automatic',
    up: `ALTER TABLE plan_queue_items ADD COLUMN landing_automatic INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // Plan Queue: how many short, tool-free turns each worker round had, kept with the round record.
    version: 53,
    name: '053_plan_queue_round_activity',
    // A profile that once ran the branch build that first added this column already has it.
    up: (db) => {
      const exists = db.prepare('PRAGMA table_info(plan_queue_items)').all<{ name: string }>()
        .some(column => column.name === 'round_activity_json');
      if (!exists) db.exec('ALTER TABLE plan_queue_items ADD COLUMN round_activity_json TEXT;');
    },
  },
  {
    // Plan Queue: a job's step number, so a plan too big for one job can run as one job per step. Takes the unique
    // (run, document) rule off the table (plan-queue-section-migration.ts).
    version: 54,
    name: '054_plan_queue_item_section',
    up: addPlanQueueSections,
  },
];

export function createLoopMigrationsTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function runLoopMigrations(db: SqliteDriver): void {
  runLoopMigrationsUpTo(db, Number.POSITIVE_INFINITY);
}

/**
 * Run migrations only up to (and including) `maxVersion`. Production always
 * calls {@link runLoopMigrations} (no cap); this variant exists so tests can
 * reconstruct an *older* app's schema — e.g. apply only versions ≤ 8 to
 * simulate a pre-worktree-columns database, then assert the v9 migration
 * upgrades it cleanly without data loss.
 */
export function runLoopMigrationsUpTo(db: SqliteDriver, maxVersion: number): void {
  createLoopMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT version FROM loop_migrations')
      .all<{ version: number }>()
      .map((r) => r.version),
  );

  const run = db.transaction(() => {
    for (const m of LOOP_MIGRATIONS) {
      if (m.version > maxVersion) continue;
      if (applied.has(m.version)) continue;
      if (typeof m.up === 'string') db.exec(m.up);
      else m.up(db);
      db.prepare(`
        INSERT INTO loop_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(m.version, m.name, Date.now());
    }
  });

  // A table rebuild (migration 54) must not cascade into the tables that point at it, and SQLite ignores this switch
  // inside a transaction, so it is flipped here and put back as it was.
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try { run(); }
  finally { db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`); }
}
