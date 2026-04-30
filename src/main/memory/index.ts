/**
 * Memory Management Module
 */

export { OutputStorageManager, getOutputStorageManager } from './output-storage';
export { MemoryMonitor, getMemoryMonitor } from './memory-monitor';
export type { MemoryStats, MemoryPressureLevel, MemoryMonitorConfig } from './memory-monitor';
export { UnifiedMemoryController, getUnifiedMemory } from './unified-controller';
export { ProjectMemoryBriefService, getProjectMemoryBriefService } from './project-memory-brief';
export type {
  ProjectMemoryBrief,
  ProjectMemoryBriefRequest,
  ProjectMemoryBriefSection,
  ProjectMemoryBriefSource,
} from './project-memory-brief';

// Phase 9: Memory-R1 Components
export { AnswerAgent, getAnswerAgent } from './answer-agent';
export type {
  AnswerConfig,
  AnswerRequest,
  AnswerResponse,
  MemorySelection,
  SelectionFeedback,
} from './answer-agent';

export { TrainingLoop, getTrainingLoop } from './training-loop';
export type {
  TrainingConfig,
  TrainingExample,
  TrainingBatch,
  TrainingMetrics,
  EpochStats,
  RewardSignal,
} from './training-loop';

export { EpisodicStore, getEpisodicStore } from './episodic-store';
export type {
  EpisodicStoreConfig,
  SessionQuery,
  PatternQuery,
  EpisodicStats,
} from './episodic-store';

export { ProceduralStore, getProceduralStore } from './procedural-store';
export type {
  ProceduralStoreConfig,
  WorkflowQuery,
  StrategyQuery,
  ProceduralStats,
  WorkflowRecommendation,
  StrategyRecommendation,
} from './procedural-store';

export { CritiqueAgent, getCritiqueAgent } from './critique-agent';
export type {
  CritiqueConfig,
  CritiqueDimension,
  CritiqueRequest,
  CritiqueResult,
  DimensionScore,
  CritiqueIssue,
  RevisionRequest,
  RevisionResult,
  ReflectionResult,
} from './critique-agent';

// Memory-R1 Manager
export { MemoryManagerAgent, getMemoryManager } from './r1-memory-manager';

// Hybrid Retrieval
export { HybridRetrievalManager } from './hybrid-retrieval';
export type {
  HybridRetrievalConfig,
  ScoredRetrievalResult,
  TrajectoryRecord,
} from './hybrid-retrieval';

// Conflict Detector
export { ConflictDetector, getConflictDetector } from './conflict-detector';
export type { ConflictType, ConflictResult } from './conflict-detector';
