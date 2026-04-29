# Wave 1-6 IPC Audit

Generated during Wave 7 final integration. The audit checked handler registrations, preload wrappers, renderer consumers, and schema coverage for the IPC added by Waves 1-6.

## Matrix

| Wave | Channel | Direction | Schema | Preload key | Domain | Renderer consumer | Status |
|---|---|---|---|---|---|---|---|
| 1 | `command:list` | renderer->main | `CommandListRequestSchema` | `listCommands` | `orchestration.preload.ts` | `command.store.ts` | OK |
| 1 | `command:resolve` | renderer->main | `CommandResolveRequestSchema` | `resolveCommand` | `orchestration.preload.ts` | `command.store.ts` | OK |
| 1 | `command:execute` | renderer->main | `CommandExecuteRequestSchema` | `executeCommand` | `orchestration.preload.ts` | `command.store.ts` | OK |
| 1 | `usage:record` | renderer->main | `UsageRecordRequestSchema` | `recordUsage` | `orchestration.preload.ts` | `usage.store.ts` | OK |
| 1 | `usage:snapshot` | renderer->main | none, no payload | `getUsageSnapshot` | `orchestration.preload.ts` | `usage.store.ts` | OK |
| 2 | `prompt-history:get-snapshot` | renderer->main | `PromptHistoryGetSnapshotRequestSchema` | `promptHistoryGetSnapshot` | `prompt-history.preload.ts` | `prompt-history.store.ts` | OK |
| 2 | `prompt-history:record` | renderer->main | `PromptHistoryRecordRequestSchema` | `promptHistoryRecord` | `prompt-history.preload.ts` | `prompt-history.store.ts` | OK |
| 2 | `prompt-history:clear-instance` | renderer->main | `PromptHistoryClearInstanceRequestSchema` | `promptHistoryClearInstance` | `prompt-history.preload.ts` | `prompt-history.store.ts` | OK |
| 2 | `prompt-history:delta` | main->renderer | `PromptHistoryDeltaPayloadSchema` | `onPromptHistoryDelta` | `prompt-history.preload.ts` | `prompt-history.store.ts` | OK |
| 3 | `workflow:can-transition` | renderer->main | `WorkflowCanTransitionRequestSchema` | `workflowCanTransition` | `workflow.preload.ts` | `orchestration-ipc.service.ts` | OK |
| 3 | `workflow:nl-suggest` | renderer->main | `WorkflowNlSuggestRequestSchema` | `workflowNlSuggest` | `workflow.preload.ts` | `orchestration-ipc.service.ts` | OK |
| 3 | `history:search-advanced` | renderer->main | `HistorySearchAdvancedRequestSchema` | `historySearchAdvanced` | `session.preload.ts` | `prompt-history-search.controller.ts` | OK |
| 3 | `history:expand-snippets` | renderer->main | `HistoryExpandSnippetsRequestSchema` | `historyExpandSnippets` | `session.preload.ts` | `prompt-history-search.controller.ts` | OK |
| 3 | `resume:latest` | renderer->main | `ResumeLatestRequestSchema` | `resumeLatest` | `session.preload.ts` | `resume-actions.service.ts` | OK |
| 3 | `resume:by-id` | renderer->main | `ResumeByIdRequestSchema` | `resumeById` | `session.preload.ts` | `resume-actions.service.ts` | OK |
| 3 | `resume:switch-to-live` | renderer->main | `ResumeSwitchToLiveRequestSchema` | `resumeSwitchToLive` | `session.preload.ts` | `resume-actions.service.ts` | OK |
| 3 | `resume:fork-new` | renderer->main | `ResumeForkNewRequestSchema` | `resumeForkNew` | `session.preload.ts` | `resume-actions.service.ts` | OK |
| 3 | `resume:restore-fallback` | renderer->main | `ResumeRestoreFallbackRequestSchema` | `resumeRestoreFallback` | `session.preload.ts` | `resume-actions.service.ts` | OK |
| 4 | none | n/a | n/a | n/a | n/a | renderer-only clipboard/theme/link work | OK |
| 5 | `orchestration:get-child-diagnostic-bundle` | renderer->main | `GetChildDiagnosticBundlePayloadSchema` | `orchestrationGetChildDiagnosticBundle` | `orchestration.preload.ts` | `quick-action-dispatcher.service.ts` | OK |
| 5 | `orchestration:summarize-children` | renderer->main | `SummarizeChildrenPayloadSchema` | `orchestrationSummarizeChildren` | `orchestration.preload.ts` | `quick-action-dispatcher.service.ts` | OK |
| 5 | `verification:verdict-ready` | main->renderer | `VerificationVerdictReadyPayloadSchema` | `onVerificationVerdictReady` | `orchestration.preload.ts` | `verification.store.ts` | OK |
| 6 | `diagnostics:get-doctor-report` | renderer->main | local Zod payload schema | `diagnosticsGetDoctorReport` | `diagnostics.preload.ts` | `doctor.store.ts` | OK |
| 6 | `diagnostics:get-skill-diagnostics` | renderer->main | none, no payload | `diagnosticsGetSkillDiagnostics` | `diagnostics.preload.ts` | Doctor diagnostics flow | OK |
| 6 | `diagnostics:get-instruction-diagnostics` | renderer->main | local Zod payload schema | `diagnosticsGetInstructionDiagnostics` | `diagnostics.preload.ts` | Doctor diagnostics flow | OK |
| 6 | `diagnostics:export-artifact-bundle` | renderer->main | local Zod payload schema | `diagnosticsExportArtifactBundle` | `diagnostics.preload.ts` | `doctor.store.ts` | OK |
| 6 | `diagnostics:reveal-bundle` | renderer->main | local Zod payload schema | `diagnosticsRevealBundle` | `diagnostics.preload.ts` | `doctor.store.ts` | OK |
| 6 | `cli-update-pill:get-state` | renderer->main | none, no payload | `cliUpdatePillGetState` | `diagnostics.preload.ts` | `cli-update-pill.store.ts` | OK |
| 6 | `cli-update-pill:refresh` | renderer->main | none, no payload | `cliUpdatePillRefresh` | `diagnostics.preload.ts` | `cli-update-pill.store.ts` | OK |
| 6 | `cli-update-pill:delta` | main->renderer | `CliUpdatePillState` payload | `onCliUpdatePillDelta` | `diagnostics.preload.ts` | `cli-update-pill.store.ts` | OK |

## Outstanding

No IPC drift was found in the Wave 7 code audit. Wave 4 introduced no new IPC channel; its clipboard, theme, link detection, and terminal-drawer boundary work is renderer-side.
