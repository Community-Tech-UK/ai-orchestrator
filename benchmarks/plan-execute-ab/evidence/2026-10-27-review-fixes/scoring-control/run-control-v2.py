from pathlib import Path
import difflib
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path(__file__).resolve().parent
EVIDENCE = ROOT / 'benchmarks/plan-execute-ab/evidence/2026-10-27-review-fixes/scoring-control'
PARENT = 'f04f674859b220b86eeb52662129072008573af9'
FIXED = '8b9721bf3c55e69259b6be4880b3acff91b68b16'
SPEC = 'src/main/history/history-manager.spec.ts'
SOURCE = 'src/main/history/history-manager.ts'
CLI = SCRATCH / 'tooling/node_modules/vitest/vitest.mjs'

AMENDMENT = r'''
  it('does not begin the safety backup before the pending startup writers settle', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    const entry = {
      id: 'entry-startup-order-control',
      displayName: 'Startup order control',
      createdAt: 1,
      endedAt: 2,
      workingDirectory: '/tmp/example',
      messageCount: 1,
      firstUserMessage: 'hello',
      lastUserMessage: 'hello',
      status: 'completed' as const,
      originalInstanceId: 'instance-startup-order-control',
      sessionId: 'session-startup-order-control',
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [entry] }),
    );
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({ entry, messages: [] })),
    );

    const startupWriteStarted = deferred();
    const releaseStartupWrite = deferred();
    const startupWaitObserved = deferred();
    const backupEntered = deferred();
    let startupSettled = false;
    let startupWriteReleased = false;
    let backupEnteredBeforeStartupSettled = false;
    const originalWriteFile = fs.promises.writeFile;
    const writeFile = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      const [file] = args;
      if (
        typeof file === 'string'
        && file.startsWith(path.join(storageDir, `${entry.id}.json.gz.`))
        && file.endsWith('.tmp')
      ) {
        startupWriteStarted.resolve();
        await releaseStartupWrite.promise;
      }
      return originalWriteFile(...args);
    });
    const originalCopy = fs.promises.cp;
    const copy = vi.spyOn(fs.promises, 'cp').mockImplementation((...args) => {
      if (!startupSettled) backupEnteredBeforeStartupSettled = true;
      return originalCopy(...args);
    });
    let startup: Promise<void> | undefined;
    let clearing: Promise<void> | undefined;
    let restoreDirectoryRead = () => {};

    try {
      const { HistoryManager } = await import('./history-manager');
      const manager = track(new HistoryManager());
      startup = manager.startupTasks;
      const actualStartup = startup;
      void actualStartup.then(() => { startupSettled = true; });
      await startupWriteStarted.promise;

      // This observation bridge delegates to the real pending startup promise.
      // Awaiting it produces a positive signal without releasing its writers.
      Object.defineProperty(manager, 'startupTasks', {
        configurable: true,
        value: {
          then(onFulfilled: (value: void) => unknown, onRejected: (reason: unknown) => unknown) {
            startupWaitObserved.resolve();
            return actualStartup.then(onFulfilled, onRejected);
          },
        },
      });

      // While the writer remains blocked, orphan recovery cannot run. A
      // directory read then can only be the safety backup entering. Keep this
      // violation recorded even if clearAll defers by arbitrary microtasks.
      const originalReadDirectory = fs.promises.readdir;
      const directoryRead = vi.spyOn(fs.promises, 'readdir').mockImplementation((...args) => {
        if (!startupSettled && !startupWriteReleased) {
          backupEnteredBeforeStartupSettled = true;
          backupEntered.resolve();
        }
        return originalReadDirectory(...args);
      });
      restoreDirectoryRead = () => directoryRead.mockRestore();
      clearing = manager.clearAll();
      const firstEvent = await Promise.race([
        startupWaitObserved.promise.then(() => 'startup-wait'),
        backupEntered.promise.then(() => 'backup-entry'),
      ]);
      expect(
        firstEvent,
        'clearAll entered the safety backup while the startup write was blocked',
      ).toBe('startup-wait');
      expect(backupEnteredBeforeStartupSettled).toBe(false);
      expect(copy).not.toHaveBeenCalled();

      startupWriteReleased = true;
      releaseStartupWrite.resolve();
      await clearing;
      await startup;
      expect(startupSettled).toBe(true);
      expect(backupEnteredBeforeStartupSettled).toBe(false);
      expect(copy).toHaveBeenCalledTimes(1);

      const backupDirs = fs.readdirSync(userDataDir)
        .filter(name => name.startsWith('conversation-history.bak-'));
      expect(backupDirs).toHaveLength(1);
      const backupDir = path.join(userDataDir, backupDirs[0]);
      const backupIndex = JSON.parse(
        fs.readFileSync(path.join(backupDir, 'index.json'), 'utf8'),
      ) as { entries: Array<{ historyThreadId: string }> };
      const backupConversation = JSON.parse(zlib.gunzipSync(
        fs.readFileSync(path.join(backupDir, `${entry.id}.json.gz`)),
      ).toString()) as ConversationData;
      expect(backupIndex.entries).toHaveLength(1);
      expect(backupIndex.entries[0].historyThreadId).toBeTruthy();
      expect(backupIndex.entries[0].historyThreadId).not.toBe(entry.sessionId);
      expect(backupConversation.entry.historyThreadId).toBe(backupIndex.entries[0].historyThreadId);
      expect(fs.existsSync(path.join(storageDir, `${entry.id}.json.gz`))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(storageDir, 'index.json'), 'utf8')).entries).toEqual([]);
      expect(manager.getEntries()).toEqual([]);
    } finally {
      startupWriteReleased = true;
      releaseStartupWrite.resolve();
      await Promise.allSettled([startup, clearing]);
      restoreDirectoryRead();
      copy.mockRestore();
      writeFile.mockRestore();
    }
  });
'''


def git_file(revision, filename):
    return subprocess.check_output(['git', 'show', f'{revision}:{filename}'], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def export(revision, name):
    target = SCRATCH / name
    if target.exists():
        raise RuntimeError(f'Owned target already exists: {target}')
    target.mkdir()
    data = subprocess.check_output(['git', 'archive', revision], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(target, filter='data')
    modules = target / 'node_modules'
    modules.mkdir()
    shared = ROOT / 'node_modules'
    owned = SCRATCH / 'tooling/node_modules'
    for name in sorted(set(p.name for p in shared.iterdir()) | set(p.name for p in owned.iterdir())):
        if name.startswith('.'):
            continue
        source = owned / name if (owned / name).exists() else shared / name
        (modules / name).symlink_to(source, target_is_directory=source.is_dir())
    (target / SPEC).write_bytes(git_file(FIXED, SPEC))
    return target


def run(target, phase, repetition):
    name = f'{target.name}-{phase}-{repetition}'
    command = ['node', str(CLI), 'run', SPEC, '--project=main', '--reporter=json',
               f'--outputFile={EVIDENCE / (name + ".json")}', '--maxWorkers=1', '--minWorkers=1']
    start = time.time()
    process = subprocess.run(command, cwd=target, capture_output=True, text=True,
                             env={**os.environ, 'CI': '1'}, timeout=180)
    (EVIDENCE / (name + '.log')).write_text(process.stdout + '\n--- stderr ---\n' + process.stderr)
    report_path = EVIDENCE / (name + '.json')
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    failures = [assertion for result in report.get('testResults', [])
                for assertion in result.get('assertionResults', []) if assertion['status'] == 'failed']
    receipt = {'command': command, 'cwd': str(target), 'exitCode': process.returncode,
               'elapsedSeconds': time.time() - start, 'numTotalTests': report.get('numTotalTests'),
               'numPassedTests': report.get('numPassedTests'), 'numFailedTests': report.get('numFailedTests'),
               'failures': failures, 'sourceSha256': digest((target / SOURCE).read_bytes()),
               'specSha256': digest((target / SPEC).read_bytes())}
    (EVIDENCE / (name + '.receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'{name}: exit={process.returncode}, passed={receipt["numPassedTests"]}, failed={receipt["numFailedTests"]}', flush=True)
    if failures:
        print('\n'.join(failures[0].get('failureMessages', []))[-4000:], flush=True)
    return receipt


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    original = git_file(FIXED, SPEC).decode()
    anchor = "  it('LT-196: folds tool-outcome records into the archive so the miner can read them back', async () => {"
    if original.count(anchor) != 1:
        raise RuntimeError('Amendment insertion point is not unique')
    amended = original.replace(anchor, AMENDMENT + '\n' + anchor)
    patch = ''.join(difflib.unified_diff(original.splitlines(True), amended.splitlines(True),
                                       fromfile='a/' + SPEC, tofile='b/' + SPEC))
    (EVIDENCE / 'held-back-ordering-amendment-v2.patch').write_text(patch)
    (EVIDENCE / 'amended-test-v2.ts.txt').write_text(AMENDMENT)
    shutil.copy2(__file__, EVIDENCE / 'run-control-v2.py')
    versions = {'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                'vitest': json.loads((SCRATCH / 'tooling/node_modules/vitest/package.json').read_text())['version']}
    seal = {'parent': PARENT, 'fixed': FIXED, 'versions': versions,
            'originalSpecSha256': digest(original.encode()), 'amendedSpecSha256': digest(amended.encode()),
            'patchSha256': digest(patch.encode()),
            'originalArchivedTestPreserved': amended.replace(AMENDMENT + '\n', '', 1) == original,
            'sourceSha256': {rev: digest(git_file(rev, SOURCE)) for rev in [PARENT, FIXED]}}
    (EVIDENCE / 'source-seal-v2.json').write_text(json.dumps(seal, indent=2) + '\n')
    targets = [SCRATCH / 'parent' if (SCRATCH / 'parent').exists() else export(PARENT, 'parent'),
               SCRATCH / 'fixed' if (SCRATCH / 'fixed').exists() else export(FIXED, 'fixed')]
    mutation = export(PARENT, 'microtask-only-parent')
    mutation_source = (mutation / SOURCE).read_text()
    before = "  async clearAll(): Promise<void> {\n    await this.createSafetyBackup('clearAll');"
    after = "  async clearAll(): Promise<void> {\n    await Promise.resolve();\n    await this.createSafetyBackup('clearAll');"
    if mutation_source.count(before) != 1:
        raise RuntimeError('Mutation insertion point is not unique')
    mutated_source = mutation_source.replace(before, after)
    (mutation / SOURCE).write_text(mutated_source)
    mutation_patch = ''.join(difflib.unified_diff(mutation_source.splitlines(True), mutated_source.splitlines(True),
                                                fromfile='a/' + SOURCE, tofile='b/' + SOURCE))
    (EVIDENCE / 'microtask-only-bogus-fix.patch').write_text(mutation_patch)
    (mutation / SPEC).write_text(amended)
    results = []
    for phase in ['amended-v2']:
        for target in targets:
            (target / SPEC).write_text(amended)
        for repetition in [1, 2]:
            for target in targets:
                results.append(run(target, phase, repetition))
    results.append(run(mutation, 'amended-v2', 1))
    (EVIDENCE / 'summary-v2.json').write_text(json.dumps({'sourceSeal': seal, 'runs': results}, indent=2) + '\n')


if __name__ == '__main__':
    main()
