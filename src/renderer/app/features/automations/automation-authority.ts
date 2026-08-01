/**
 * WS-C5 — automation operating-authority contract.
 *
 * A pure, config-driven module that turns an automation's REAL config fields
 * into six plain-language cards (May access / May change / Must ask before /
 * Stops when / Verification / Report destination), each statement marked
 * honestly as `'technical'` (a real, engineered mechanism the run cannot
 * silently ignore — verified against the actual runner/loop code) or
 * `'instruction-only'` (only prose the model is asked to follow; nothing
 * stops it from ignoring that request).
 *
 * Every statement here was checked against the code that actually enforces
 * it — see the enforcement notes in each builder below — so this module must
 * NEVER present a prompt instruction as a technical guarantee. When this
 * codebase gains no real gate for something (e.g. there is currently no
 * "block git push" mechanism), that gap is reported honestly as
 * instruction-only rather than glossed over.
 */

import type {
  Automation,
  AutomationConcurrencyPolicy,
  AutomationExecutionProfile,
} from '../../../../shared/types/automation.types';
import type { AutomationFormModel } from './automation-form-model';

export type AutomationAuthorityEnforcement = 'technical' | 'instruction-only';

export type AutomationAuthorityCardKind =
  | 'mayAccess'
  | 'mayChange'
  | 'mustAskBefore'
  | 'stopsWhen'
  | 'verification'
  | 'reportDestination'
  | 'containment';

/** Which real config field (or fixed system mechanism) backs a statement. */
export type AutomationAuthoritySource =
  | 'action.workingDirectory'
  | 'action.forceNodeId'
  | 'action.yoloMode'
  | 'action.prompt'
  | 'action.loop.isolateWorkspace'
  | 'action.loop.verifyCommand'
  | 'action.loop.maxIterations'
  | 'action.loop.maxCostCents'
  | 'concurrencyPolicy'
  | 'destination'
  | 'system:consecutive-failure-breaker'
  | 'system:unattended-wait-guard'
  | 'action.executionProfile';

export interface AutomationAuthorityStatement {
  /** Plain-language description of what the automation may DO — no jargon. */
  statement: string;
  enforcement: AutomationAuthorityEnforcement;
  source: AutomationAuthoritySource;
}

export interface AutomationAuthorityCard {
  kind: AutomationAuthorityCardKind;
  title: string;
  statements: AutomationAuthorityStatement[];
}

export interface AutomationAuthorityContract {
  cards: AutomationAuthorityCard[];
}

/** Normalized shape the derivation reads — built from either the live form or a persisted Automation. */
export interface AutomationAuthorityInput {
  workingDirectory: string;
  yoloMode: boolean;
  forceNodeId?: string;
  concurrencyPolicy: AutomationConcurrencyPolicy;
  destinationKind: 'newInstance' | 'thread';
  loop: {
    enabled: boolean;
    verifyCommand: string;
    isolateWorkspace: boolean;
    maxIterations?: number;
    maxCostCents?: number;
  };
  /** WS-C7 — absent/`'standard'` means no containment card is shown. */
  executionProfile?: AutomationExecutionProfile;
}

/**
 * Mirrors `DEFAULT_MAX_CONSECUTIVE_FAILURES` in
 * `src/main/automations/automation-store.ts`. Not currently a per-automation
 * config field, so it is stated as a fixed system guarantee rather than tied
 * to a form field; kept as a local constant because renderer code cannot
 * import main-process modules.
 */
const AUTO_DISABLE_THRESHOLD = 5;

/** Build the derivation input from the live automation editor form. */
export function formToAuthorityInput(model: AutomationFormModel): AutomationAuthorityInput {
  const maxIterations = Number.parseInt(model.loopMaxIterations, 10);
  const maxCostCents = Number.parseInt(model.loopMaxCostCents, 10);
  return {
    workingDirectory: model.workingDirectory,
    yoloMode: model.yoloMode,
    forceNodeId: model.forceNodeId.trim() || undefined,
    concurrencyPolicy: model.concurrencyPolicy,
    // The automation form never edits `destination` — every automation it
    // creates or edits reports into a brand-new session (see
    // automations-page.component.ts#save, which never sets `destination`).
    destinationKind: 'newInstance',
    loop: {
      enabled: model.loopEnabled,
      verifyCommand: model.loopVerifyCommand.trim(),
      isolateWorkspace: model.loopIsolateWorkspace,
      maxIterations: Number.isFinite(maxIterations) && maxIterations > 0 ? maxIterations : undefined,
      maxCostCents: Number.isFinite(maxCostCents) && maxCostCents > 0 ? maxCostCents : undefined,
    },
    executionProfile: model.executionProfile,
  };
}

/** Build the derivation input from a persisted Automation (detail/preflight views). */
export function automationToAuthorityInput(automation: Automation): AutomationAuthorityInput {
  return {
    workingDirectory: automation.action.workingDirectory,
    yoloMode: automation.action.yoloMode ?? false,
    forceNodeId: automation.action.forceNodeId,
    concurrencyPolicy: automation.concurrencyPolicy,
    destinationKind: automation.destination.kind,
    loop: {
      enabled: Boolean(automation.action.loop),
      verifyCommand: automation.action.loop?.verifyCommand ?? '',
      isolateWorkspace: automation.action.loop?.isolateWorkspace ?? true,
      maxIterations: automation.action.loop?.maxIterations,
      maxCostCents: automation.action.loop?.maxCostCents,
    },
    executionProfile: automation.action.executionProfile,
  };
}

export function deriveAutomationAuthority(input: AutomationAuthorityInput): AutomationAuthorityContract {
  return {
    cards: [
      mayAccessCard(input),
      mayChangeCard(input),
      mustAskBeforeCard(input),
      stopsWhenCard(input),
      verificationCard(input),
      reportDestinationCard(input),
      ...(input.executionProfile === 'contained' ? [containmentCard()] : []),
    ],
  };
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * `action.workingDirectory` becomes the CLI process's real working directory
 * (automation-runner.ts createInstance -> workingDirectory), and
 * `action.forceNodeId` overrides remote-node placement (see
 * execution-location-resolver.ts). Both are engineered facts, not prompt
 * text — but the working directory is NOT a filesystem jail (no per-run
 * sandbox confines reads/writes to it today), so the statement below
 * describes it as a rooting fact, never as a boundary.
 */
function mayAccessCard(input: AutomationAuthorityInput): AutomationAuthorityCard {
  const statements: AutomationAuthorityStatement[] = [];
  const dir = input.workingDirectory.trim();
  if (dir) {
    statements.push({
      statement: `Runs from the ${folderName(dir)} project folder (${dir}) — that is genuinely where it starts, not just wording in the prompt.`,
      enforcement: 'technical',
      source: 'action.workingDirectory',
    });
  } else {
    statements.push({
      statement: 'No project folder is set yet — it cannot run until one is chosen.',
      enforcement: 'technical',
      source: 'action.workingDirectory',
    });
  }
  if (input.forceNodeId) {
    statements.push({
      statement: `Only runs on the pinned worker node "${input.forceNodeId}" — it will not fall back to any other machine.`,
      enforcement: 'technical',
      source: 'action.forceNodeId',
    });
  }
  return { kind: 'mayAccess', title: 'May access', statements };
}

/**
 * `action.yoloMode` is compiled straight into each provider's spawn flags
 * (e.g. codex `sandboxMode: 'danger-full-access' | 'read-only'`, claude's
 * permission hook, `--yolo`) — a real switch, not advice. `loop.isolateWorkspace`
 * is passed to the loop engine as `isolateLoopWorkspaces`, which acquires a
 * separate git worktree before any file is touched (loop-coordinator.ts).
 */
function mayChangeCard(input: AutomationAuthorityInput): AutomationAuthorityCard {
  const statements: AutomationAuthorityStatement[] = [];
  statements.push(
    input.yoloMode
      ? {
          statement: 'Can create, edit, and run commands in that folder on its own, without pausing to ask first.',
          enforcement: 'technical',
          source: 'action.yoloMode',
        }
      : {
          statement: "Is kept to safe, read-leaning actions — the CLI's own approval and sandbox settings block or stall anything riskier.",
          enforcement: 'technical',
          source: 'action.yoloMode',
        },
  );
  if (input.loop.enabled) {
    statements.push(
      input.loop.isolateWorkspace
        ? {
            statement: 'Makes its changes in a separate, isolated copy of the folder (a worktree) — never directly in your live checkout.',
            enforcement: 'technical',
            source: 'action.loop.isolateWorkspace',
          }
        : {
            statement: 'Makes its changes directly in your live checkout for this folder — there is no separate copy standing in between.',
            enforcement: 'technical',
            source: 'action.loop.isolateWorkspace',
          },
    );
  }
  return { kind: 'mayChange', title: 'May change', statements };
}

/**
 * When yolo mode is off, an approval prompt cannot be answered by anyone
 * (the automation runs unattended), so `automation-runner.ts` treats
 * `waiting_for_permission` as a hard failure rather than pausing — a real
 * stop, not a suggestion. When yolo mode is on, nothing in this codebase
 * technically stops it from doing something the prompt merely asked it to
 * avoid (e.g. "don't push") — that gap is reported honestly.
 */
function mustAskBeforeCard(input: AutomationAuthorityInput): AutomationAuthorityCard {
  const statements: AutomationAuthorityStatement[] = [];
  if (!input.yoloMode) {
    statements.push({
      statement: 'Must ask before doing anything that needs approval — and because it runs unattended with nobody there to answer, it stops the run instead of guessing.',
      enforcement: 'technical',
      source: 'action.yoloMode',
    });
  } else {
    statements.push({
      statement: 'Nothing — yolo mode is on, so it never pauses to ask before acting.',
      enforcement: 'technical',
      source: 'action.yoloMode',
    });
    statements.push({
      statement: "Beyond what yolo mode itself blocks, the only other limits come from what the prompt asks it to avoid — that's a request, not a lock, and it can be ignored.",
      enforcement: 'instruction-only',
      source: 'action.prompt',
    });
  }
  return { kind: 'mustAskBefore', title: 'Must ask before', statements };
}

/**
 * The consecutive-failure breaker (automation-store-outcome-ops.ts) and the
 * unattended wait-state guard (automation-runner.ts handleInstanceEvent /
 * reconcileInstanceState) are real, code-level stops. `concurrencyPolicy` is
 * enforced in `AutomationStore.decideAndInsertRun`. Loop `maxIterations` /
 * `maxCostCents` are passed straight into the loop engine's caps
 * (automation-loop-run.ts buildAutomationLoopConfig).
 */
function stopsWhenCard(input: AutomationAuthorityInput): AutomationAuthorityCard {
  const statements: AutomationAuthorityStatement[] = [
    {
      statement: `Automatically pauses itself after ${AUTO_DISABLE_THRESHOLD} runs in a row fail, until it's re-enabled.`,
      enforcement: 'technical',
      source: 'system:consecutive-failure-breaker',
    },
    {
      statement: 'Stops (fails) rather than silently carrying on if it hits a point where it would need a human to approve or answer something while running unattended.',
      enforcement: 'technical',
      source: 'system:unattended-wait-guard',
    },
  ];
  statements.push(
    input.concurrencyPolicy === 'queue'
      ? {
          statement: 'Queues a scheduled run behind an in-progress one instead of skipping it.',
          enforcement: 'technical',
          source: 'concurrencyPolicy',
        }
      : {
          statement: 'Skips a scheduled run if a previous run of this automation is still going, instead of piling up.',
          enforcement: 'technical',
          source: 'concurrencyPolicy',
        },
  );
  if (input.loop.enabled) {
    if (input.loop.maxIterations) {
      statements.push({
        statement: `Stops after ${input.loop.maxIterations} loop iterations, even if the work isn't finished.`,
        enforcement: 'technical',
        source: 'action.loop.maxIterations',
      });
    }
    if (input.loop.maxCostCents) {
      statements.push({
        statement: `Stops if this run's cost passes $${(input.loop.maxCostCents / 100).toFixed(2)}.`,
        enforcement: 'technical',
        source: 'action.loop.maxCostCents',
      });
    }
    if (!input.loop.maxIterations && !input.loop.maxCostCents) {
      statements.push({
        statement: "Stops at the loop engine's own default iteration and cost caps — no custom limit is set for this automation.",
        enforcement: 'technical',
        source: 'action.loop.maxIterations',
      });
    }
  }
  return { kind: 'stopsWhen', title: 'Stops when', statements };
}

/**
 * A loop action's `verifyCommand` is compiled into `completion.verifyCommand`
 * for `prepareLoopStartConfig`/the loop coordinator — a real, run gate
 * (blank means "auto-detect the working directory's own verifier", still
 * resolved in code, not left to the model). A one-shot (non-loop) automation
 * has no equivalent gate at all today — any "check your work" behaviour comes
 * only from the prompt, so that is reported as instruction-only.
 */
function verificationCard(input: AutomationAuthorityInput): AutomationAuthorityCard {
  const statements: AutomationAuthorityStatement[] = [];
  if (input.loop.enabled) {
    statements.push(
      input.loop.verifyCommand
        ? {
            statement: `Only calls the work finished after \`${input.loop.verifyCommand}\` passes.`,
            enforcement: 'technical',
            source: 'action.loop.verifyCommand',
          }
        : {
            statement: "Uses this project folder's own verification (its usual test/lint/typecheck command) before calling the work finished — resolved automatically, not left to the model's judgement.",
            enforcement: 'technical',
            source: 'action.loop.verifyCommand',
          },
    );
  } else {
    statements.push({
      statement: 'Runs no automatic verification of its own work — any checking that happens is only what the prompt asks it to do, and it can skip that.',
      enforcement: 'instruction-only',
      source: 'action.prompt',
    });
  }
  return { kind: 'verification', title: 'Verification', statements };
}

/**
 * `destination.kind` decides whether a run's output lands in a new session
 * or an existing conversation thread — set at automation-create time and
 * read straight by `automation-runner.ts#dispatchRun`, not a description.
 */
function reportDestinationCard(input: AutomationAuthorityInput): AutomationAuthorityCard {
  const statement: AutomationAuthorityStatement = input.destinationKind === 'thread'
    ? {
        statement: 'Reports back into the same existing conversation thread each time it runs, instead of starting a new one.',
        enforcement: 'technical',
        source: 'destination',
      }
    : {
        statement: "Starts a brand-new session for every run — its output shows up in the instance list, not tucked into an existing conversation.",
        enforcement: 'technical',
        source: 'destination',
      };
  return { kind: 'reportDestination', title: 'Report destination', statements: [statement] };
}

/**
 * WS-C7 — the `contained` execution profile's containment guarantees, all
 * real mechanisms verified against code:
 *  - `sandboxMode: 'read-only'` (Codex's own sandbox) — `AutomationRunner`
 *    forces `yoloMode: false` for a contained run regardless of the
 *    automation's own toggle (automation-runner.ts dispatchRun/dispatchRetryRun),
 *    and `createCodexAdapter` (adapter-factory.ts) maps that straight to
 *    `sandboxMode: 'read-only'`, which also blocks all outbound network.
 *  - the spawn environment is derived from `getSafeEnv()` instead of the
 *    unfiltered pass-through (adapter-spawn-helpers.ts `mergeSpawnEnv`), so no
 *    API keys, tokens, or other host secrets reach the child process.
 *  - the fire-time gate (automation-execution-profile-gate.ts) refuses the
 *    run outright — it never spawns at all — when the resolved provider isn't
 *    Codex, the only provider with a real sandbox in this codebase.
 * Only appended when `executionProfile` is `'contained'`.
 */
function containmentCard(): AutomationAuthorityCard {
  return {
    kind: 'containment',
    title: 'What this run can access',
    statements: [
      {
        statement: "Filesystem is read-only — it cannot create, edit, or delete files, no matter what the prompt or the rest of the config says.",
        enforcement: 'technical',
        source: 'action.executionProfile',
      },
      {
        statement: 'No network access at all — it cannot reach the internet, so it cannot git push, install packages, or call any external service.',
        enforcement: 'technical',
        source: 'action.executionProfile',
      },
      {
        statement: "Cannot see any API keys, tokens, or other secrets from your environment — its process environment is filtered down to a safe minimum before it starts.",
        enforcement: 'technical',
        source: 'action.executionProfile',
      },
      {
        statement: 'Only ever runs on Codex, the one provider this app can actually sandbox — if it would resolve to any other provider, the run fails outright instead of running unsandboxed.',
        enforcement: 'technical',
        source: 'action.executionProfile',
      },
    ],
  };
}

// --- Templates ---------------------------------------------------------------

export type AutomationAuthorityTemplateId =
  | 'read-only-monitor'
  | 'prepare-dont-publish'
  | 'single-repo-implementation';

export interface AutomationAuthorityTemplate {
  id: AutomationAuthorityTemplateId;
  name: string;
  description: string;
  apply: (model: AutomationFormModel) => Partial<AutomationFormModel>;
}

/**
 * Three one-click presets, each setting REAL config fields so the resulting
 * authority contract is true, not aspirational. They form an honest
 * increasing-authority ladder using the only fields this codebase actually
 * enforces (`yoloMode`, `loop.enabled`, `loop.isolateWorkspace`):
 *
 *  1. Read-only monitor      — yolo off: no writes complete unattended.
 *  2. Prepare, don't publish — yolo on + isolated worktree: writes happen,
 *     but never touch the live checkout and are never auto-published.
 *  3. Implement in one repo  — yolo on, one bounded turn (no loop): writes
 *     land directly in the live checkout, with no open-ended autonomy.
 *
 * None of these can technically stop the model from running `git push` (or
 * similar) once yolo mode is on — the contract must say so rather than
 * imply a sandbox that doesn't exist.
 */
export const AUTOMATION_AUTHORITY_TEMPLATES: AutomationAuthorityTemplate[] = [
  {
    id: 'read-only-monitor',
    name: 'Read-only monitor',
    description: 'Looks and reports only. Cannot make changes; stops instead of guessing if it hits something that needs approval.',
    apply: () => ({
      yoloMode: false,
      loopEnabled: false,
      concurrencyPolicy: 'skip',
    }),
  },
  {
    id: 'prepare-dont-publish',
    name: "Prepare, don't publish",
    description: 'Can make changes, but only in a separate isolated copy of the folder — your live checkout is never touched and nothing is published automatically.',
    apply: () => ({
      yoloMode: true,
      loopEnabled: true,
      loopIsolateWorkspace: true,
      concurrencyPolicy: 'skip',
    }),
  },
  {
    id: 'single-repo-implementation',
    name: 'Implement in one repo',
    description: 'A single focused turn that writes directly in this project folder — no isolation copy, no open-ended autonomous looping.',
    apply: () => ({
      yoloMode: true,
      loopEnabled: false,
      concurrencyPolicy: 'skip',
    }),
  },
];
