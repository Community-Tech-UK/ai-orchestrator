import { app } from 'electron';
import { startHarnessMainProcess } from './main-process-bootstrap';

void startHarnessMainProcess({
  app,
  argv: process.argv,
  loadMain: () => import('./index'),
}).catch((error: unknown) => {
  console.error('Harness main-process bootstrap failed', error);
  app.exit(1);
});
