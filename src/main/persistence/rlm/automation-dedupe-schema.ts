/**
 * Migration 052: one-off consolidation of byte-identical duplicate automations.
 *
 * Phase 1 of the idempotent-create work (`automation-equivalence.ts`) stops the
 * bleeding: an agent re-issuing `create_automation` for the same recurring check
 * now reuses the existing automation instead of inserting another shell. This
 * migration cleans up the piles that accumulated *before* that guard, so a
 * workspace shows one automation with a long run history rather than ten
 * near-identical shells each with a run history of its own.
 *
 * Safety posture — this runs unattended for every user and cannot be undone, so
 * a group is only merged when the merge provably loses nothing:
 *
 * - Grouping is on the *whole* persisted configuration (`workspace_id`,
 *   `schedule_type`, `schedule_json`, `trigger_json`, `action_json`), not just
 *   the Phase-1 key of schedule + prompt + provider. `action_json` also carries
 *   `systemAction`, `model`, `yoloMode` and friends; two automations that differ
 *   there are genuinely different work even when the prompt matches. Only `name`
 *   and `description` — the fields agents actually reword — are ignored, which is
 *   exactly the pile-up this targets.
 * - Only `active = 1`, schedule-triggered automations are candidates. Fired
 *   one-time automations (`active = 0`) and webhook-triggered automations are
 *   left alone.
 * - Automations with attachments are skipped entirely. Attachments are not part
 *   of any equivalence key, so an identical prompt does not imply identical
 *   attachments and merging could silently drop a file.
 * - Automations with a `running`/`pending` run are skipped, so no in-flight run
 *   is ever repointed or deleted. Such a duplicate is simply merged on a later
 *   launch.
 * - Automations referenced by a webhook route's `allowed_automation_ids_json`
 *   are skipped: that is a soft (non-FK) reference this migration cannot rewrite.
 *
 * The keeper is the earliest-created member (tie-break: lowest id), so the
 * automation with the longest history survives and the choice is stable.
 *
 * What the merge does lose, deliberately: `automation_runs` has a UNIQUE index on
 * `(automation_id, scheduled_at) WHERE trigger IN ('scheduled','catchUp')`, and
 * identical cron automations fire on the same aligned tick, so their runs collide
 * on repoint. Where a tick already has a keeper run, the losers' runs for that
 * tick are dropped; where it does not, the best loser run is kept (failed >
 * succeeded > cancelled > skipped, then earliest). Those dropped rows are extra
 * executions of the *same* prompt in the *same* tick — the redundancy this whole
 * change exists to remove. Losers' thread destinations are dropped too: the
 * keeper's configuration is the survivor.
 */
export const AUTOMATION_DEDUPE_UP_SQL = `
  CREATE TABLE _automation_dedupe_candidates (
    id TEXT PRIMARY KEY,
    grp TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  INSERT INTO _automation_dedupe_candidates (id, grp, created_at)
  SELECT
    a.id,
    json_array(a.workspace_id, a.schedule_type, a.schedule_json, a.trigger_json, a.action_json),
    a.created_at
  FROM automations a
  WHERE a.active = 1
    AND json_extract(a.trigger_json, '$.kind') = 'schedule'
    AND NOT EXISTS (
      SELECT 1 FROM automation_attachments t WHERE t.automation_id = a.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM automation_runs r
      WHERE r.automation_id = a.id AND r.status IN ('running', 'pending')
    )
    AND NOT EXISTS (
      SELECT 1 FROM webhook_routes w
      WHERE w.allowed_automation_ids_json LIKE '%"' || a.id || '"%'
    );

  CREATE INDEX _automation_dedupe_candidates_grp
    ON _automation_dedupe_candidates(grp, created_at, id);

  CREATE TABLE _automation_dedupe_map (
    loser_id TEXT PRIMARY KEY,
    keeper_id TEXT NOT NULL
  );

  INSERT INTO _automation_dedupe_map (loser_id, keeper_id)
  SELECT
    c.id,
    (SELECT k.id FROM _automation_dedupe_candidates k
      WHERE k.grp = c.grp ORDER BY k.created_at ASC, k.id ASC LIMIT 1)
  FROM _automation_dedupe_candidates c
  WHERE c.id <> (
    SELECT k.id FROM _automation_dedupe_candidates k
    WHERE k.grp = c.grp ORDER BY k.created_at ASC, k.id ASC LIMIT 1
  );

  CREATE INDEX _automation_dedupe_map_keeper ON _automation_dedupe_map(keeper_id);

  -- Fold the few state fields that legitimately diverge into the keeper before
  -- the loser rows go away. Everything else (name, policies, failure counters)
  -- is the keeper's own, per "the keeper's configuration is the survivor".
  --   enabled       -> max: if any member was live, the merged check stays live.
  --   last_fired_at -> max: the group fired on the same ticks; keep the latest.
  --   next_fire_at  -> the keeper's own when set; otherwise the *latest* of the
  --                    losers', so re-enabling never adopts an ancient tick and
  --                    triggers a catch-up storm.
  --   updated_at    -> max: the row did just change.
  UPDATE automations
  SET
    enabled = max(
      enabled,
      COALESCE((
        SELECT max(l.enabled) FROM automations l
        JOIN _automation_dedupe_map m ON m.loser_id = l.id
        WHERE m.keeper_id = automations.id
      ), 0)
    ),
    -- -1 stands in for "never fired" so scalar max() does not collapse to NULL;
    -- NULLIF puts the NULL back when no member of the group has ever fired.
    last_fired_at = NULLIF(max(
      COALESCE(last_fired_at, -1),
      COALESCE((
        SELECT max(l.last_fired_at) FROM automations l
        JOIN _automation_dedupe_map m ON m.loser_id = l.id
        WHERE m.keeper_id = automations.id
      ), -1)
    ), -1),
    next_fire_at = COALESCE(
      next_fire_at,
      (
        SELECT max(l.next_fire_at) FROM automations l
        JOIN _automation_dedupe_map m ON m.loser_id = l.id
        WHERE m.keeper_id = automations.id
      )
    ),
    updated_at = max(
      updated_at,
      COALESCE((
        SELECT max(l.updated_at) FROM automations l
        JOIN _automation_dedupe_map m ON m.loser_id = l.id
        WHERE m.keeper_id = automations.id
      ), updated_at)
    )
  WHERE id IN (SELECT keeper_id FROM _automation_dedupe_map);

  -- Drop loser runs that cannot be repointed because the keeper's tick is taken.
  -- A keeper's own run always wins; between two loser runs the more informative
  -- status wins, then the earlier row.
  DELETE FROM automation_runs
  WHERE id IN (
    SELECT r.id
    FROM automation_runs r
    JOIN _automation_dedupe_map m ON m.loser_id = r.automation_id
    WHERE r.trigger IN ('scheduled', 'catchUp')
      AND EXISTS (
        SELECT 1
        FROM automation_runs o
        LEFT JOIN _automation_dedupe_map om ON om.loser_id = o.automation_id
        WHERE o.id <> r.id
          AND o.trigger IN ('scheduled', 'catchUp')
          AND o.scheduled_at = r.scheduled_at
          AND COALESCE(om.keeper_id, o.automation_id) = m.keeper_id
          AND (
            CASE WHEN om.keeper_id IS NULL THEN 0 ELSE 1 END,
            CASE o.status
              WHEN 'failed' THEN 0
              WHEN 'succeeded' THEN 1
              WHEN 'cancelled' THEN 2
              ELSE 3
            END,
            o.created_at,
            o.id
          ) < (
            1,
            CASE r.status
              WHEN 'failed' THEN 0
              WHEN 'succeeded' THEN 1
              WHEN 'cancelled' THEN 2
              ELSE 3
            END,
            r.created_at,
            r.id
          )
      )
  );

  -- Same treatment for the external-idempotency unique index
  -- (automation_id, trigger, idempotency_key) WHERE idempotency_key IS NOT NULL.
  DELETE FROM automation_runs
  WHERE id IN (
    SELECT r.id
    FROM automation_runs r
    JOIN _automation_dedupe_map m ON m.loser_id = r.automation_id
    WHERE r.idempotency_key IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM automation_runs o
        LEFT JOIN _automation_dedupe_map om ON om.loser_id = o.automation_id
        WHERE o.id <> r.id
          AND o.idempotency_key = r.idempotency_key
          AND o.trigger = r.trigger
          AND COALESCE(om.keeper_id, o.automation_id) = m.keeper_id
          AND (
            CASE WHEN om.keeper_id IS NULL THEN 0 ELSE 1 END,
            o.created_at,
            o.id
          ) < (1, r.created_at, r.id)
      )
  );

  UPDATE automation_runs
  SET automation_id = (
    SELECT m.keeper_id FROM _automation_dedupe_map m
    WHERE m.loser_id = automation_runs.automation_id
  )
  WHERE automation_id IN (SELECT loser_id FROM _automation_dedupe_map);

  -- automation_thread_destinations is keyed by automation_id, so the keeper's row
  -- (if any) is the survivor and the losers' are dropped rather than repointed.
  DELETE FROM automation_thread_destinations
  WHERE automation_id IN (SELECT loser_id FROM _automation_dedupe_map);

  -- No-op by construction (attachment-bearing automations are never candidates);
  -- kept explicit because foreign keys may be disabled during migrations.
  DELETE FROM automation_attachments
  WHERE automation_id IN (SELECT loser_id FROM _automation_dedupe_map);

  DELETE FROM automations
  WHERE id IN (SELECT loser_id FROM _automation_dedupe_map);

  DROP INDEX _automation_dedupe_map_keeper;
  DROP TABLE _automation_dedupe_map;
  DROP INDEX _automation_dedupe_candidates_grp;
  DROP TABLE _automation_dedupe_candidates;
`;
