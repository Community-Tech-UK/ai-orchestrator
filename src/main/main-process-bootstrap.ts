export const MAIN_PROCESS_HEAP_FLAG = '--js-flags=--max-old-space-size=8192';

interface RelaunchableApp {
  relaunch(options: { args: string[] }): void;
  exit(exitCode?: number): void;
}

interface MainProcessBootstrapOptions {
  app: RelaunchableApp;
  argv: string[];
  loadMain: () => Promise<unknown>;
}

export async function startHarnessMainProcess(
  options: MainProcessBootstrapOptions,
): Promise<void> {
  if (!options.argv.includes(MAIN_PROCESS_HEAP_FLAG)) {
    options.app.relaunch({
      args: [MAIN_PROCESS_HEAP_FLAG, ...options.argv.slice(1)],
    });
    options.app.exit(0);
    return;
  }

  await options.loadMain();
}
