import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundTaskManager } from './background-task-manager';

afterEach(() => BackgroundTaskManager._resetForTesting());
describe('background task admission', () => {
  it('leaves a denied task pending and runs it once when admission changes', async () => {
    const manager = BackgroundTaskManager.getInstance();
    let allowed = false;
    let executions = 0;
    manager.registerExecutor('repo-job:review', async () => { executions++; return 'reviewed'; });
    manager.registerAdmissionGate('repo-job:review', () => allowed);
    const task = manager.submit({ type: 'repo-job:review', name: 'Review' });
    expect(task.status).toBe('pending');
    expect(executions).toBe(0);
    allowed = true;
    manager.requestPump();
    expect((await manager.waitFor(task.id)).success).toBe(true);
    expect(executions).toBe(1);
  });
});
