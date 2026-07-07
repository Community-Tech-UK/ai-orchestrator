export const DEFAULT_CODE_INDEX_IGNORES = [
  '.git/',
  // Loop Mode runtime scratch (per-run state/attachments/control) is not source.
  '.aio-loop-attachments/',
  '.aio-loop-control/',
  '.aio-loop-state/',
  '.angular/',
  '.cache/',
  '.gradle/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.parcel-cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '.svelte-kit/',
  '.turbo/',
  '.venv/',
  '_archive/',
  '_scratch/',
  'build/',
  'cache/',
  'coverage/',
  'dist/',
  'external-benchmarks/',
  'libraries/',
  'node_modules/',
  'out/',
  'release/',
  'target/',
  '__pycache__/',
  'venv/',
  'vendor/',
  '**/*.class',
  '**/*.7z',
  '**/*.bz2',
  '**/*.dmg',
  '**/*.gz',
  '**/*.jar',
  '**/*.lock',
  '**/*.log',
  '**/*.map',
  '**/*.min.css',
  '**/*.min.js',
  '**/*.rar',
  '**/*.tar',
  '**/*.tar.bz2',
  '**/*.tar.gz',
  '**/*.tar.xz',
  '**/*.tgz',
  '**/*.war',
  '**/*.xz',
  '**/*.zip',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

export function codeIndexIgnoresAsGlobPatterns(): string[] {
  return DEFAULT_CODE_INDEX_IGNORES.map((pattern) => {
    if (pattern.startsWith('**/')) return pattern;
    if (pattern.endsWith('/')) return `**/${pattern}**`;
    if (pattern.includes('*')) return pattern;
    return `**/${pattern}`;
  });
}

export function codeIndexDirectoryIgnoreNames(): string[] {
  return DEFAULT_CODE_INDEX_IGNORES
    .filter((pattern) => pattern.endsWith('/') && !pattern.includes('*'))
    .map((pattern) => pattern.slice(0, -1));
}
