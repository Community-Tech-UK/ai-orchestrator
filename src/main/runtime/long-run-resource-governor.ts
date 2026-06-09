export type LongRunResourceLevel = 'ok' | 'warn' | 'critical';
export type LongRunResourceAction =
  | 'disable-warm-start'
  | 'skip-optional-memory-context'
  | 'pause-loop'
  | 'prune-codemem';

export interface LongRunResourceSnapshot {
  rssBytes: number;
  codememDbBytes: number;
  rlmDbBytes: number;
  contextWorkerDegraded: boolean;
  indexWorkerDegraded: boolean;
}

export interface LongRunResourceGovernorConfig {
  warnRssBytes: number;
  criticalRssBytes: number;
  maxCodememDbBytes: number;
  maxRlmDbBytes: number;
}

export interface LongRunResourceDecision {
  level: LongRunResourceLevel;
  actions: LongRunResourceAction[];
  reasons: string[];
}

export class LongRunResourceGovernor {
  constructor(private readonly config: LongRunResourceGovernorConfig) {}

  evaluate(snapshot: LongRunResourceSnapshot): LongRunResourceDecision {
    const actions = new Set<LongRunResourceAction>();
    const reasons: string[] = [];
    let level: LongRunResourceLevel = 'ok';

    if (snapshot.rssBytes >= this.config.criticalRssBytes) {
      level = 'critical';
      actions.add('pause-loop');
      actions.add('disable-warm-start');
      actions.add('skip-optional-memory-context');
      reasons.push('rss-above-critical');
    } else if (snapshot.rssBytes >= this.config.warnRssBytes) {
      level = 'warn';
      actions.add('disable-warm-start');
      actions.add('skip-optional-memory-context');
      reasons.push('rss-above-warning');
    }

    if (snapshot.codememDbBytes >= this.config.maxCodememDbBytes) {
      if (level === 'ok') level = 'warn';
      actions.add('prune-codemem');
      reasons.push('codemem-db-above-limit');
    }

    if (snapshot.rlmDbBytes >= this.config.maxRlmDbBytes) {
      level = 'critical';
      actions.add('pause-loop');
      actions.add('skip-optional-memory-context');
      reasons.push('rlm-db-above-limit');
    }

    return { level, actions: [...actions], reasons };
  }
}
