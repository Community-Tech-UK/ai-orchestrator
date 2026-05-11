/**
 * Memory Domain Bootstrap
 *
 * Initializes memory agents, knowledge graph, conversation miner,
 * wake context builder, codebase miner, and RLM subsystems.
 */

import { registerBootstrapModule } from './index';

export function registerMemoryBootstrap(): void {
  registerBootstrapModule({
    name: 'Project story directory',
    domain: 'memory',
    failureMode: 'degraded',
    init: () => {
      // Ensure the `.aio/` git-trackable project memory directory exists
      // (decisions.md, lessons.md, handovers.md). Idempotent: skips files
      // that already exist. See src/main/memory/project-story-convention.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ensureProjectStoryDir } = require(
        '../memory/project-story-convention',
      ) as typeof import('../memory/project-story-convention');
      ensureProjectStoryDir();
    },
  });

  registerBootstrapModule({
    name: 'Memory agents',
    domain: 'memory',
    failureMode: 'degraded',
    init: () => {
      const { getAnswerAgent } = require('../memory/answer-agent') as typeof import('../memory/answer-agent');
      const { getCritiqueAgent } = require('../memory/critique-agent') as typeof import('../memory/critique-agent');
      const { getKnowledgeGraphService } = require('../memory/knowledge-graph-service') as typeof import('../memory/knowledge-graph-service');
      const { getConversationMiner } = require('../memory/conversation-miner') as typeof import('../memory/conversation-miner');
      const { getWakeContextBuilder } = require('../memory/wake-context-builder') as typeof import('../memory/wake-context-builder');
      const { getCodebaseMiner } = require('../memory/codebase-miner') as typeof import('../memory/codebase-miner');
      const { getProjectCodeIndexBridge } = require('../memory/project-code-index-bridge') as typeof import('../memory/project-code-index-bridge');
      const { getProjectKnowledgeCoordinator } = require('../memory/project-knowledge-coordinator') as typeof import('../memory/project-knowledge-coordinator');
      const { getProjectKnowledgeReadModelService } = require('../memory/project-knowledge-read-model') as typeof import('../memory/project-knowledge-read-model');

      getAnswerAgent();
      getCritiqueAgent();
      getKnowledgeGraphService();
      getConversationMiner();
      getWakeContextBuilder();
      getCodebaseMiner();
      getProjectCodeIndexBridge();
      getProjectKnowledgeCoordinator();
      getProjectKnowledgeReadModelService();
    },
  });

  registerBootstrapModule({
    name: 'RLM subsystem',
    domain: 'memory',
    failureMode: 'degraded',
    dependencies: ['Memory agents'],
    teardown: () => {
      const { getSummarizationWorker } = require('../rlm/summarization-worker') as typeof import('../rlm/summarization-worker');
      getSummarizationWorker().stop();
    },
    init: () => {
      const { getRLMContextManager } = require('../rlm/context-manager') as typeof import('../rlm/context-manager');
      const { getEpisodicRLMStore } = require('../rlm/episodic-rlm-store') as typeof import('../rlm/episodic-rlm-store');
      const { getSmartCompactionManager } = require('../rlm/smart-compaction') as typeof import('../rlm/smart-compaction');
      const { getSummarizationWorker } = require('../rlm/summarization-worker') as typeof import('../rlm/summarization-worker');

      getRLMContextManager();
      getEpisodicRLMStore();
      getSmartCompactionManager();
      const worker = getSummarizationWorker();
      worker.initialize();
      worker.start();
    },
  });
}
