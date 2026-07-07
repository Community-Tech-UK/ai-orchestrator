import type { WorkflowPhase, WorkflowTemplate } from '../../../shared/types/workflow.types';

const releasePlanPhase = (
  platform: 'ios' | 'android',
  builderName: 'buildIosReleasePlan' | 'buildAndroidReleasePlan',
): WorkflowPhase => ({
  id: 'release-plan',
  name: 'Release Plan',
  description: `Build the machine-readable ${platform} release plan and identify blockers`,
  order: 0,
  gateType: 'completion',
  requiredActions: ['release_plan_built'],
  systemPromptAddition: `
## Current Phase: RELEASE PLAN

Use \`${builderName}\` from \`src/main/release/mobile-release-plan.ts\` as the source of truth for the release sequence.

1. Read repo instructions and app-specific release config.
2. Check credential references without printing secret values.
3. Build the release plan and resolve or report every blocker before continuing.
4. Do not substitute browser upload for API/CLI upload steps.

Mark \`release_plan_built\` after the plan has no unresolved blockers or the blockers have been reported.
`,
});

export const iosReleaseWorkflowTemplate: WorkflowTemplate = {
  id: 'ios-release',
  name: 'iOS Release',
  description: 'API-first iOS App Store Connect/TestFlight release with explicit verification gates',
  icon: 'upload-cloud',
  category: 'release',
  triggerPatterns: [
    '/ios-release',
    'ios release',
    'testflight release',
    'app store release',
    'upload ipa',
  ],
  autoTrigger: false,
  estimatedDuration: '45-120 minutes',
  requiredAgents: ['release-engineer'],
  phases: [
    releasePlanPhase('ios', 'buildIosReleasePlan'),
    {
      id: 'local-build-and-upload',
      name: 'Build And Upload',
      description: 'Archive, export, and upload the IPA through altool',
      order: 1,
      gateType: 'completion',
      requiredActions: ['archive_exported', 'ipa_uploaded'],
      systemPromptAddition: `
## Current Phase: LOCAL BUILD AND UPLOAD

Follow the iOS release plan exactly:

1. Run project verification gates first.
2. Archive with \`xcodebuild\`.
3. Export the IPA with an app-store-connect ExportOptions plist.
4. Upload with \`xcrun altool --upload-app\`; do not use browser build upload.

Mark \`archive_exported\` and \`ipa_uploaded\` only after command output proves each step.
`,
    },
    {
      id: 'store-api-finalization',
      name: 'ASC Finalization',
      description: 'Poll processing, set compliance, and attach TestFlight or submit through ASC API',
      order: 2,
      gateType: 'completion',
      requiredActions: ['asc_processing_done', 'asc_finalized'],
      systemPromptAddition: `
## Current Phase: APP STORE CONNECT API FINALIZATION

Use ASC API reads/writes for processing, export compliance, TestFlight group attachment, metadata, and review submission where available.

1. Poll until build processing is complete.
2. Set export compliance.
3. Attach the build to the requested TestFlight group, or submit for review only with explicit James approval.
4. Verify from a fresh ASC read before moving on.
`,
    },
    verificationPhase(3, 'iOS'),
    summaryPhase(4),
  ],
};

export const androidReleaseWorkflowTemplate: WorkflowTemplate = {
  id: 'android-release',
  name: 'Android Release',
  description: 'Play Developer Publishing API release with browser fallback for console-only declarations',
  icon: 'package-up',
  category: 'release',
  triggerPatterns: [
    '/android-release',
    'android release',
    'play release',
    'google play release',
    'upload aab',
  ],
  autoTrigger: false,
  estimatedDuration: '45-120 minutes',
  requiredAgents: ['release-engineer'],
  phases: [
    releasePlanPhase('android', 'buildAndroidReleasePlan'),
    {
      id: 'local-build-and-upload',
      name: 'Build AAB',
      description: 'Verify signing and build the signed release bundle',
      order: 1,
      gateType: 'completion',
      requiredActions: ['signing_verified', 'aab_built'],
      systemPromptAddition: `
## Current Phase: LOCAL BUILD

Follow the Android release plan exactly:

1. Verify upload keystore properties and Android SDK config.
2. Run project verification gates.
3. Build the signed AAB with \`bundleRelease\`.
4. Verify the expected AAB path exists before using Play APIs.
`,
    },
    {
      id: 'play-api-finalization',
      name: 'Play API Finalization',
      description: 'Upload the AAB, update the track, and commit the edit through Play APIs',
      order: 2,
      gateType: 'completion',
      requiredActions: ['play_edit_committed'],
      systemPromptAddition: `
## Current Phase: PLAY API FINALIZATION

Use the Play Developer Publishing API for recurring release work:

1. Create an edit.
2. Upload the AAB through the API.
3. Update the requested track and rollout.
4. Commit the edit only after a fresh read verifies the draft state.
`,
    },
    {
      id: 'browser-console-gaps',
      name: 'Browser Console Gaps',
      description: 'Use checkpointed browser flow only where Play has no public API',
      order: 3,
      gateType: 'completion',
      requiredActions: ['console_gaps_verified'],
      systemPromptAddition: `
## Current Phase: BROWSER CONSOLE GAPS

Use \`new-app-setup\` for console-only Play work such as Content rating, Data safety, app access, policy declarations, and Play App Signing SHA capture.

Every browser mutation needs read-back verification or screenshot evidence. Check the artifact library and "Add from library" before retrying an interrupted browser upload.
`,
    },
    verificationPhase(4, 'Android'),
    summaryPhase(5),
  ],
};

export const newAppSetupWorkflowTemplate: WorkflowTemplate = {
  id: 'new-app-setup',
  name: 'New App Setup',
  description: 'Checkpointed browser workflow for App Store Connect and Play Console setup gaps',
  icon: 'clipboard-check',
  category: 'release',
  triggerPatterns: [
    '/new-app-setup',
    'new app setup',
    'play console setup',
    'app store connect setup',
    'data safety',
    'content rating',
    'privacy nutrition labels',
  ],
  autoTrigger: false,
  estimatedDuration: '60-180 minutes',
  requiredAgents: ['release-engineer'],
  phases: [
    {
      id: 'setup-plan',
      name: 'Setup Plan',
      description: 'Build the checkpointed browser setup plan and identify blockers',
      order: 0,
      gateType: 'completion',
      requiredActions: ['setup_plan_built'],
      systemPromptAddition: `
## Current Phase: SETUP PLAN

Use \`buildNewAppSetupPlan\` from \`src/main/release/mobile-release-plan.ts\`.

1. Identify which Play and ASC console-only sections apply.
2. Build a checkpointed plan.
3. Confirm account/legal/identity prompts will be escalated, not auto-answered.
`,
    },
    {
      id: 'campaign-lease',
      name: 'Campaign Lease',
      description: 'Claim or verify the browser campaign lease before unattended console changes',
      order: 1,
      gateType: 'completion',
      requiredActions: ['campaign_lease_active'],
      systemPromptAddition: `
## Current Phase: CAMPAIGN LEASE

Call \`browser.claim_campaign_lease\` for the approved release campaign before console mutations.

Verify the lease is node-scoped/origin-scoped, active, and in budget. Stop if no lease is available.
`,
    },
    {
      id: 'play-console-setup',
      name: 'Play Console Setup',
      description: 'Complete Play app creation and console-only declarations with checkpoints',
      order: 2,
      gateType: 'completion',
      requiredActions: ['play_checkpoints_verified'],
      systemPromptAddition: `
## Current Phase: PLAY CONSOLE SETUP

For each Play step, record a checkpoint after save with URL, heading, app/package identity, saved-state text, and read-back selectors.

Cover app creation, app content declarations, Content rating, Data safety CSV import, app access credentials, and policy declarations as applicable.
`,
    },
    {
      id: 'asc-console-setup',
      name: 'ASC Console Setup',
      description: 'Complete ASC app records and privacy labels with checkpoints',
      order: 3,
      gateType: 'completion',
      requiredActions: ['asc_checkpoints_verified'],
      systemPromptAddition: `
## Current Phase: ASC CONSOLE SETUP

For App Store Connect, use the logged-in browser session for app record creation when appropriate and for privacy nutrition labels.

Record checkpoints after every save and verify privacy nutrition labels after reload. Escalate agreements, tax, banking, identity, and legal prompts.
`,
    },
    verificationPhase(4, 'new app setup'),
    summaryPhase(5),
  ],
};

function verificationPhase(order: number, label: string): WorkflowPhase {
  return {
    id: 'verification',
    name: 'Verification',
    description: `Verify ${label} release evidence before reporting status`,
    order,
    gateType: 'completion',
    requiredActions: ['verification_run'],
    systemPromptAddition: `
## Current Phase: VERIFICATION

Run the relevant tests, type checks, API reads, browser read-backs, and smoke checks for this release.

Do not report success until command output or live store/API/browser evidence proves the requested release state.
`,
  };
}

function summaryPhase(order: number): WorkflowPhase {
  return {
    id: 'summary',
    name: 'Summary',
    description: 'Report release status, evidence, and remaining prompts',
    order,
    gateType: 'none',
    systemPromptAddition: `
## Current Phase: SUMMARY

Report done, stalled, or needs-permission with the release plan, executed steps, verification evidence, and exact remaining manual prompts.
`,
  };
}
