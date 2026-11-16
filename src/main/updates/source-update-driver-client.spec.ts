import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceUpdateDriverClient } from './source-update-driver-client';

const roots: string[] = [];
const COMMIT = 'a'.repeat(40);
function fixture(program: string) {
  const folder = mkdtempSync(path.join(tmpdir(), 'source-update-client-'));
  roots.push(folder);
  const driver = path.join(folder, 'driver.cjs');
  const config = path.join(folder, 'config.json');
  writeFileSync(driver, program);
  writeFileSync(config, JSON.stringify({
    version: 1, repositoryPath: folder, remote: 'origin', branch: 'main',
    appPath: path.join(folder, 'Harness.app'), nodePath: process.execPath, driverPath: driver,
  }), { mode: 0o600 });
  return { folder, config, client: new SourceUpdateDriverClient(config) };
}

describe('source updater Node protocol', () => {
  afterEach(() => { for (const folder of roots.splice(0)) rmSync(folder, { recursive: true, force: true }); });

  it('passes the installed commit through stdin and validates the real child response', async () => {
    const { client } = fixture(`let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
      const request=JSON.parse(input);console.log(JSON.stringify({available:false,commit:request.installedCommit}));});`);
    await expect(client.probe({ installedCommit: COMMIT }, new AbortController().signal))
      .resolves.toEqual({ available: false, commit: COMMIT });
  });

  it('refuses malformed responses without exposing child error text', async () => {
    const { client } = fixture(`process.stdin.resume();process.stdin.on('end',()=>console.log('PRIVATE_OUTPUT_PLACEHOLDER'));`);
    await expect(client.probe({ installedCommit: COMMIT }, new AbortController().signal))
      .rejects.toThrow('The source update helper did not complete its request.');
  });

  it('refuses a configuration other users can read before spawning a helper', () => {
    const { config, client } = fixture('process.exit(0)');
    chmodSync(config, 0o644);
    expect(() => client.probe({ installedCommit: COMMIT }, new AbortController().signal)).toThrow();
  });

  it('does not commit a prepared activation until asked and then lets its child outlive the parent connection', async () => {
    const { folder, client } = fixture(`const fs=require('node:fs');const path=require('node:path');
      const rl=require('node:readline').createInterface({input:process.stdin});let first=true;
      process.stdout.on('error',error=>{if(error.code!=='EPIPE')throw error});
      rl.on('line',line=>{const request=JSON.parse(line);if(first){first=false;console.log(JSON.stringify({ready:true}));}
        else if(request.action==='commit'){rl.close();setTimeout(()=>{fs.writeFileSync(path.join(__dirname,'committed'),'yes');process.exit(0)},30)}
        else process.exit(0);});`);
    const controller = new AbortController();
    const activation = await client.prepare({ commit: COMMIT, appPath: path.join(folder, 'next.app'), parentPid: process.pid, sessions: [] }, controller.signal);
    expect(existsSync(path.join(folder, 'committed'))).toBe(false);
    await activation.commit();
    controller.abort();
    await vi.waitFor(() => expect(readFileSync(path.join(folder, 'committed'), 'utf8')).toBe('yes'));
  });

  it('cancels its own running probe and waits for the child to exit', async () => {
    const { folder, client } = fixture(`const fs=require('node:fs');const path=require('node:path');
      fs.writeFileSync(path.join(__dirname,'pid'),String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const result = client.probe({ installedCommit: COMMIT }, controller.signal);
    const failure = expect(result).rejects.toThrow('The source update helper did not complete its request.');
    await vi.waitFor(() => expect(existsSync(path.join(folder, 'pid'))).toBe(true));
    const pid = Number(readFileSync(path.join(folder, 'pid'), 'utf8'));
    controller.abort();
    await failure;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each([false, true])('reaps an activation helper ignoring termination (prepared: %s)', async prepared => {
    const { folder, client } = fixture(`const fs=require('node:fs');const path=require('node:path');
      process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);
      fs.writeFileSync(path.join(__dirname,'pid'),String(process.pid));
      ${prepared ? "console.log(JSON.stringify({ready:true}));" : ''}`);
    const controller = new AbortController();
    const result = client.prepare({ commit: COMMIT, appPath: path.join(folder, 'next.app'), parentPid: process.pid, sessions: [] }, controller.signal);
    const failure = prepared ? undefined : expect(result).rejects.toThrow('The source update helper did not complete its request.');
    let pid: number | undefined;
    const exited = (childPid: number): boolean => {
      try { process.kill(childPid, 0); return false; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    };
    try {
      await vi.waitFor(() => expect(existsSync(path.join(folder, 'pid'))).toBe(true));
      const childPid = Number(readFileSync(path.join(folder, 'pid'), 'utf8'));
      pid = childPid;
      if (prepared) await result;
      controller.abort();
      await failure;
      await vi.waitFor(() => expect(exited(childPid)).toBe(true), { timeout: 7_000 });
    } finally {
      controller.abort();
      if (pid && !exited(pid)) {
        process.kill(pid, 'SIGKILL');
        const childPid = pid;
        await vi.waitFor(() => expect(exited(childPid)).toBe(true), { timeout: 3_000 });
      }
    }
  }, 15_000);
});
