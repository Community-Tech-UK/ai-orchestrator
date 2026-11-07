import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareScoringDependencies, verifyScoringDependencies } from '../../../scoring-setup';
import { scoreRun } from '../../../scorer';
const dir=join(import.meta.dirname,'host-probe-workspace');mkdirSync(dir,{recursive:true});
try {
 writeFileSync(join(dir,'package.json'),'{"name":"fixture","version":"1.0.0"}');
 writeFileSync(join(dir,'package-lock.json'),JSON.stringify({name:'fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0'}}}));
 const original=await prepareScoringDependencies(dir);
 const score=await scoreRun({hiddenTestCommand:[process.execPath,'-e','console.log(require.resolve("vitest/package.json"))'],damageCommands:[]} as never,{workspaceDir:dir});
 console.log(JSON.stringify({original,verified:verifyScoringDependencies(dir),score},null,2));
} finally {rmSync(dir,{recursive:true,force:true});}
