import fs from 'node:fs';
import path from 'node:path';
import { prepareScoringDependencies } from '../../../scoring-setup.ts';
import { scoreRun } from '../../../scorer.ts';
const root = path.dirname(new URL(import.meta.url).pathname);
const dir = path.join(root, 'probe-score-workspace');
fs.mkdirSync(dir, {recursive:true});
const pkg = { name:'fixture',version:'1.0.0', scripts:{test:'oxlint --version'}};
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(pkg));
fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':pkg}}));
try {
 const dependencies=await prepareScoringDependencies(dir);
 const score=await scoreRun({hiddenTestCommand:['npm','test'],damageCommands:[]},{workspaceDir:dir,dependencies,logDir:root+'/host-tool-scoring'});
 fs.writeFileSync(path.join(root,'host-tool-score.json'),JSON.stringify({threw:false,score},null,2)+'\n');
 console.log(JSON.stringify({threw:false,passed:score.hiddenTests.passed,exitCode:score.hiddenTests.exitCode}));
} catch(error) {fs.writeFileSync(path.join(root,'host-tool-score.json'),JSON.stringify({threw:true,error:String(error)},null,2)+'\n');console.log(String(error));}
finally {fs.rmSync(dir,{recursive:true,force:true});}
