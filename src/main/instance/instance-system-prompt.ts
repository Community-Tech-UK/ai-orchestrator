/**
 * Instance system-prompt assembly (extracted from instance-lifecycle.ts to
 * keep it under the LOC ratchet ceiling).
 *
 * Builds a fresh instance's system prompt via the locked injection contract
 * (WS-B4): every block is registered through `composer` in
 * `SYSTEM_PROMPT_BLOCK_ORDER` so the assembled prompt stays byte-stable for
 * identical inputs (prompt-cache prefix reuse). See prompt-injection-contract.ts
 * for the contract itself.
 *
 * Also builds the initial-turn runtime context block (indexed codebase
 * context for the first message) and kicks off project-knowledge mining —
 * neither is one of the nine system-prompt blocks, but both are computed
 * inline here to preserve the exact interleaved execution order the
 * pre-extraction code ran in (between the wake-context and mcp-tool-context
 * blocks).
 *
 * Extraction contract: `assembleInstanceSystemPrompt`'s composed prompt and
 * manifest-log shape must stay byte-identical to the pre-extraction code —
 * see instance-lifecycle-system-prompt-contract.spec.ts, which exercises the
 * real InstanceLifecycleManager.createInstance() path.
 */

import type { AgentProfile } from '../../shared/types/agent.types';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import type { McpRuntimeToolContextSelection } from '../mcp/mcp-runtime-tool-context';
import { getMcpManager } from '../mcp/mcp-manager';
import { getContextWorkerClient } from './context-worker-client';
import { getProjectMemoryBriefService } from '../memory/project-memory-brief';
import { extractAuthoredLessons } from '../memory/project-story-convention';
import { getProjectKnowledgeCoordinator } from '../memory/project-knowledge-coordinator';
import { getIndexedCodebaseContextService } from '../indexing/indexed-codebase-context';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { callWithDeadline } from '../util/deadline';
import {
  applyOutputStyle,
  isOutputStyleInjectableProvider,
  isOutputStyleName,
} from './output-style';
import { getOutputStyleRegistry } from './output-style-registry';
import { buildToolPermissionPrompt } from './lifecycle/tool-permission-prompt';
import { isRestoreOrReplayContinuity } from './lifecycle/create-validation-helpers';
import {
  createSystemPromptComposer,
  type SystemPromptBlockManifestEntry,
} from '../context/prompt-injection-contract';
import type { LifecycleDependencies } from './instance-lifecycle.types';

const logger = getLogger('InstanceSystemPrompt');

/**
 * How long create-time prompt enrichers (observation memory, MCP tool
 * context) may run before we assemble the system prompt without them. A
 * genuinely-async enricher that exceeds this is not waited on; its result,
 * if it eventually arrives, is deferred into the next turn as a continuity
 * preamble rather than blocking the first send. (Synchronous enrichers
 * can't be interrupted by a deadline — those need an off-thread move,
 * tracked separately.)
 */
const CREATE_ENRICHER_DEADLINE_MS = 600;

/** The subset of `LifecycleDependencies` this assembly needs, plus a callback for deferred enrichers. */
export interface AssembleInstanceSystemPromptDeps {
  buildObservationContext: LifecycleDependencies['buildObservationContext'];
  buildWakeContextText: LifecycleDependencies['buildWakeContextText'];
  buildMcpRuntimeToolContextSelection: LifecycleDependencies['buildMcpRuntimeToolContextSelection'];
  /** Queues a create-time enricher that missed its deadline into the next turn's continuity preamble. */
  deferEnricherPreamble: (instanceId: string, label: string, text: string | null) => void;
}

export interface AssembleInstanceSystemPromptParams {
  instance: Instance;
  config: InstanceCreateConfig;
  resolvedAgent: AgentProfile;
  /** Merged INSTRUCTIONS.md / CLAUDE.md hierarchy (empty for child instances). */
  instructionPrompts: readonly string[];
  /** The initial user message content, if any — feeds the indexed codebase context lookup. */
  initialUserMessageContent: string | undefined;
  deps: AssembleInstanceSystemPromptDeps;
}

export interface AssembleInstanceSystemPromptResult {
  systemPrompt: string;
  systemPromptManifest: SystemPromptBlockManifestEntry[];
  /** Hidden runtime-only context to prepend to the initial prompt sent to the provider. */
  initialRuntimeContextBlock: string | undefined;
}

/**
 * Build a fresh instance's initial-turn runtime context block (indexed
 * codebase context for the first message). Not one of the nine system-prompt
 * blocks — kept here (rather than back in instance-lifecycle.ts) purely to
 * preserve its original execution position relative to the wake-context and
 * mcp-tool-context blocks.
 */
async function buildInitialRuntimeContextBlock(
  instance: Instance,
  config: InstanceCreateConfig,
  initialPrompt: string | undefined,
): Promise<string | undefined> {
  const blocks = [config.initialContextBlock?.trim()].filter(Boolean) as string[];
  const prompt = initialPrompt?.trim();
  if (!prompt || instance.depth !== 0 || isRestoreOrReplayContinuity(config)) {
    return blocks.length > 0 ? blocks.join('\n\n') : undefined;
  }

  try {
    const service = getIndexedCodebaseContextService();
    const indexedContext = await service.buildContext({
      workspacePath: instance.workingDirectory,
      query: prompt,
      maxTokens: 900,
      topK: 5,
    });
    const indexedBlock = service.formatContextBlock(indexedContext);
    if (indexedBlock) {
      blocks.push(indexedBlock);
      logger.info('Injected indexed codebase context into initial prompt', {
        instanceId: instance.id,
        storeId: indexedContext?.storeId,
        resultCount: indexedContext?.results.length ?? 0,
        tokens: indexedContext?.tokens ?? 0,
      });
    }
  } catch (error) {
    logger.warn('Failed to build indexed codebase context for initial prompt', {
      instanceId: instance.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

/**
 * Assemble a fresh instance's system prompt via the locked injection
 * contract (WS-B4): every block is registered through `composer` in
 * `SYSTEM_PROMPT_BLOCK_ORDER` so the assembled prompt stays byte-stable for
 * identical inputs (prompt-cache prefix reuse). See prompt-injection-contract.ts.
 */
export async function assembleInstanceSystemPrompt(
  params: AssembleInstanceSystemPromptParams,
): Promise<AssembleInstanceSystemPromptResult> {
  const { instance, config, resolvedAgent, instructionPrompts, initialUserMessageContent, deps } = params;
  const settings = getSettingsManager();

  const systemPromptComposer = createSystemPromptComposer();

  let instructionsBlockContent = resolvedAgent.systemPrompt || '';
  if (instructionPrompts.length > 0) {
    const instructionSection = instructionPrompts.join('\n\n---\n\n');
    instructionsBlockContent = `${instructionSection}\n\n---\n\n${instructionsBlockContent}`;
    logger.info('Prepended instruction prompts to system prompt', { count: instructionPrompts.length });
  }

  // Output style (claude2_todo #29): append the selected communication-style
  // directive for root sessions on system-prompt-injectable providers.
  // Default 'default' is a no-op, so this is inert unless the user opts in.
  // A 'replace'-mode user style (full-prompt-swap) folds into the
  // instructions block itself rather than the output-style block, since
  // it discards the base prompt entirely — matching
  // applyResolvedOutputStyle's original behaviour.
  let outputStyleBlockContent = '';
  if (instance.depth === 0) {
    const outputStyle = settings.getAll().outputStyle;
    if (outputStyle && outputStyle !== 'default' && isOutputStyleInjectableProvider(config.provider)) {
      if (isOutputStyleName(outputStyle)) {
        // Built-in style (unchanged behaviour — append-only).
        const directive = applyOutputStyle('', outputStyle);
        if (directive) {
          outputStyleBlockContent = directive;
          logger.info('Applied output style to system prompt', { outputStyle });
        }
      } else {
        // User-authored `.md` style: append or full-prompt-swap (mode: replace).
        const userStyle = await getOutputStyleRegistry()
          .resolveUserStyle(instance.workingDirectory, outputStyle)
          .catch((err) => {
            logger.warn('User output-style resolution failed', { outputStyle, error: String(err) });
            return null;
          });
        if (userStyle && userStyle.directive) {
          if (userStyle.mode === 'replace') {
            instructionsBlockContent = userStyle.directive;
          } else {
            outputStyleBlockContent = userStyle.directive;
          }
          logger.info('Applied output style to system prompt', { outputStyle });
        }
      }
    }
  }

  systemPromptComposer.add('instructions', instructionsBlockContent);
  systemPromptComposer.add('output-style', outputStyleBlockContent);

  // Inject observation memory context (learned reflections from past sessions).
  // Deadline-bounded and off-thread via the context worker.
  try {
    const promptSoFar = systemPromptComposer.compose().text;
    const observationContext = await callWithDeadline(
      deps.buildObservationContext(promptSoFar, instance.id, config.initialPrompt),
      {
        ms: CREATE_ENRICHER_DEADLINE_MS,
        fallback: '',
        onTimeout: () =>
          logger.info('Observation context exceeded create deadline; deferring to next turn', {
            instanceId: instance.id,
          }),
        onError: (err) =>
          logger.warn('Failed to inject observation context', {
            error: err instanceof Error ? err.message : String(err),
          }),
        onLateResult: (text) => deps.deferEnricherPreamble(instance.id, 'observation', text),
      },
    );
    systemPromptComposer.add('observation-memory', observationContext);
    if (observationContext) {
      logger.info('Injected observation memory context into system prompt');
    }
  } catch (err) {
    logger.warn('Failed to inject observation context', { error: err instanceof Error ? err.message : String(err) });
  }

  // Inject a compact, project-scoped memory brief for fresh root sessions.
  if (instance.depth === 0 && !isRestoreOrReplayContinuity(config)) {
    try {
      const projectBriefRequest = {
        projectPath: instance.workingDirectory,
        instanceId: instance.id,
        initialPrompt: config.initialPrompt,
        provider: config.provider,
        model: config.modelOverride || resolvedAgent.modelOverride || settings.getAll().defaultModel,
      };
      let projectBrief = await getContextWorkerClient()
        .buildProjectMemoryBrief(projectBriefRequest)
        .catch((error) => {
          logger.warn('Context worker failed to build project memory brief; falling back to main process', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      projectBrief ??= await getProjectMemoryBriefService().buildBrief(projectBriefRequest);
      if (projectBrief.text.trim()) {
        systemPromptComposer.add('project-brief', projectBrief.text);
        logger.info('Injected project memory brief into system prompt', {
          projectKey: projectBrief.stats.projectKey,
          candidatesScanned: projectBrief.stats.candidatesScanned,
          candidatesIncluded: projectBrief.stats.candidatesIncluded,
          sourceCounts: projectBrief.sources.reduce<Record<string, number>>((counts, source) => {
            counts[source.type] = (counts[source.type] ?? 0) + 1;
            return counts;
          }, {}),
          truncated: projectBrief.stats.truncated,
        });
      }
    } catch (err) {
      logger.warn('Failed to inject project memory brief', {
        error: err instanceof Error ? err.message : String(err),
        instanceId: instance.id,
      });
    }
  }

  // A7#15: inject authored project lessons (.aio/lessons.md) into fresh
  // root sessions. The file is git-trackable and written by humans/agents;
  // injecting it carries hard-won knowledge into the next session. Skipped
  // when the file holds only its skeleton placeholder (no real entries).
  if (instance.depth === 0 && !isRestoreOrReplayContinuity(config)) {
    try {
      const lessons = extractAuthoredLessons({ projectRoot: instance.workingDirectory });
      if (lessons) {
        systemPromptComposer.add('lessons', lessons);
        logger.info('Injected project lessons into system prompt', {
          instanceId: instance.id,
          chars: lessons.length,
        });
      }
    } catch (err) {
      logger.warn('Failed to inject project lessons', {
        error: err instanceof Error ? err.message : String(err),
        instanceId: instance.id,
      });
    }
  }

  // E14: inject a compact ranked repo map for fresh root sessions so the
  // agent has structural project context without reading every file.
  if (instance.depth === 0 && !isRestoreOrReplayContinuity(config)
      && instance.workingDirectory && settings.getAll().injectRepoMap) {
    try {
      const { getRepoMapService } = await import('../memory/repo-map-service');
      const repoMap = await getRepoMapService().buildRepoMap({
        projectPath: instance.workingDirectory,
        tokenBudget: settings.getAll().repoMapTokenBudget,
      });
      if (repoMap.text.trim()) {
        systemPromptComposer.add('repo-map', repoMap.text);
        logger.info('Injected repo map into system prompt', {
          instanceId: instance.id,
          filesIncluded: repoMap.stats.filesIncluded,
          filesConsidered: repoMap.stats.filesConsidered,
          tokensUsed: repoMap.stats.tokensUsed,
          truncated: repoMap.stats.truncated,
          fallback: repoMap.stats.fallback,
        });
      }
    } catch (err) {
      logger.warn('Failed to inject repo map', {
        error: err instanceof Error ? err.message : String(err),
        instanceId: instance.id,
      });
    }
  }

  // Inject wake-up context (mempalace L0 identity + L1 essential story)
  if (instance.depth === 0) {
    try {
      const wakeText = await callWithDeadline(
        () => deps.buildWakeContextText(instance.workingDirectory),
        {
          ms: CREATE_ENRICHER_DEADLINE_MS,
          fallback: null,
          onTimeout: () =>
            logger.info('Wake context exceeded create deadline; continuing without it', {
              instanceId: instance.id,
            }),
          onError: (error) =>
            logger.warn('Failed to build wake context off-thread', {
              instanceId: instance.id,
              error: error instanceof Error ? error.message : String(error),
            }),
        },
      );
      if (wakeText && wakeText.trim().length > 30) {
        systemPromptComposer.add('wake-context', wakeText);
        logger.info('Injected wake-up context into system prompt', {
          tokenEstimate: sharedEstimateTokens(wakeText),
        });
      }
    } catch (err) {
      logger.warn('Failed to inject wake context', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Register and refresh project knowledge for the working directory (async, fire-and-forget).
  if (instance.depth === 0 && instance.workingDirectory) {
    getProjectKnowledgeCoordinator().ensureProjectKnown(
      instance.workingDirectory,
      'instance-working-directory',
      { autoRefresh: true },
    ).catch((err) => {
      logger.warn('Codebase mining failed', {
        error: err instanceof Error ? err.message : String(err),
        workingDirectory: instance.workingDirectory,
      });
    });
  }

  const initialRuntimeContextBlock = await buildInitialRuntimeContextBlock(
    instance,
    config,
    initialUserMessageContent,
  );

  // MCP runtime tool selection. Deadline-bounded: a slow tool-load (or a
  // large connector set) defers into the next turn rather than holding up
  // the first send.
  try {
    const mcpManager = getMcpManager();
    const runtimeToolSelection = await callWithDeadline<
      McpRuntimeToolContextSelection | null
    >(
      () =>
        deps.buildMcpRuntimeToolContextSelection(
          mcpManager.exportRuntimeToolContextSnapshot(),
          config.initialPrompt,
          6,
        ),
      {
        ms: CREATE_ENRICHER_DEADLINE_MS,
        fallback: null,
        onTimeout: () =>
          logger.info('MCP tool context exceeded create deadline; deferring to next turn', {
            instanceId: instance.id,
          }),
        onLateResult: (selection) => {
          if (!selection) {
            return;
          }
          void mcpManager
            .hydrateRuntimeToolContextSelection(selection)
            .then((ctx) => {
              deps.deferEnricherPreamble(
                instance.id,
                'mcp',
                mcpManager.formatRuntimeToolContext(ctx),
              );
            })
            .catch((error) => {
              logger.warn('Failed to hydrate deferred MCP tool context', {
                instanceId: instance.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        },
      },
    );
    const runtimeToolContext = runtimeToolSelection
      ? await mcpManager.hydrateRuntimeToolContextSelection(runtimeToolSelection)
      : null;
    const mcpPrompt = runtimeToolContext
      ? mcpManager.formatRuntimeToolContext(runtimeToolContext)
      : null;
    if (runtimeToolContext && mcpPrompt) {
      systemPromptComposer.add('mcp-tool-context', mcpPrompt);
      logger.info('Injected deferred MCP runtime tool context into system prompt', {
        selectedTools: runtimeToolContext.selectedTools.length,
        deferredToolCount: runtimeToolContext.deferredToolCount,
        serverCount: runtimeToolContext.serverSummaries.length,
      });
    }
  } catch (err) {
    logger.warn('Failed to inject MCP runtime tool context', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  systemPromptComposer.add('tool-permissions', buildToolPermissionPrompt(instance.yoloMode));

  const { text: systemPrompt, manifest: systemPromptManifest } = systemPromptComposer.compose();
  // No existing persistence field for this manifest (see WS-B4 spec) — a
  // later workstream owns storing/exposing it. Debug-log it so it is at
  // least visible for local diagnosis of unexpected cache-prefix churn.
  logger.debug('Composed system prompt manifest', {
    instanceId: instance.id,
    blocks: systemPromptManifest,
  });

  return { systemPrompt, systemPromptManifest, initialRuntimeContextBlock };
}
