type ExitProcess = (code: number) => never;

/** Explicitly terminates one-shot Electron utility processes after synchronous work completes. */
export function exitOneShotProcess(
  operation: () => number,
  exit: ExitProcess = process.exit,
): never {
  return exit(operation());
}
