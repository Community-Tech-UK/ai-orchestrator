/**
 * Memory Domain Bootstrap
 *
 * Initializes memory agents, knowledge graph, conversation miner,
 * wake context builder, codebase miner, and RLM subsystems.
 */

import { registerBootstrapModule } from './index';

export function registerMemoryBootstrap(): void {
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

      getAnswerAgent();
      getCritiqueAgent();
      getKnowledgeGraphService();
      getConversationMiner();
      getWakeContextBuilder();
      getCodebaseMiner();
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
