export interface FetchRtkTarget {
  key: string;
  asset: string;
  archive: 'tar.gz' | 'zip';
  binary: string;
}

export declare const TARGETS: FetchRtkTarget[];
export declare const RTK_VERSION: string;
export declare function selectTargets(argv: readonly string[], platform?: string): FetchRtkTarget[];
export declare function decideExit(
  results: readonly { key: string; error?: string }[],
  mode: 'strict' | 'soft' | 'default',
): number;
export declare function deadlineMsFor(
  mode: 'strict' | 'soft' | 'default',
  env?: Record<string, string | undefined>,
): number;
