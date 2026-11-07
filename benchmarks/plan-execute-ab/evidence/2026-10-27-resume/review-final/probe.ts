import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareScoringDependencies, verifyScoringDependencies } from '../../../scoring-setup';
import { scoreRun } from '../../../scorer';
const dir = join(import.meta.dirname, 'probe-workspace');
mkdirSync(dir, {recursive: true});
try {
 writeFileSync(join(dir,'package.json'), '{"name":"fixture","version":"1.0.0"}');
 writeFileSync(join(dir,'package-lock.json'), JSON.stringify({name:'fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0'}}}));
 const original=await prepareScoringDependencies(dir);
 rmSync(join(dir,'package.json'));rmSync(join(dir,'package-lock.json'));
 let after: unknown;
 try { after={accepted:true,receipt:verifyScoringDependencies(dir)}; } catch(e) { after={accepted:false,error:String(e)}; }
 const missing=await scoreRun({hiddenTestCommand:['definitely-missing-benchmark-test-binary'],damageCommands:[]} as never,{workspaceDir:dir});
 console.log(JSON.stringify({original,afterDeletingAllManifests:after,missingCommandScore:missing},null,2));
} finally {rmSync(dir,{recursive:true,force:true});}
