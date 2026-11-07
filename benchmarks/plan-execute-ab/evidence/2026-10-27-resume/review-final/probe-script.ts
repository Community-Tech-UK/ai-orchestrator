import {mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {prepareScoringDependencies} from '../../../scoring-setup';import {scoreRun} from '../../../scorer';
const dir=join(import.meta.dirname,'script-probe-workspace');mkdirSync(dir,{recursive:true});try {
const pkg={name:'fixture',version:'1.0.0',scripts:{test:'definitely-missing-benchmark-test-binary'}};
writeFileSync(join(dir,'package.json'),JSON.stringify(pkg));writeFileSync(join(dir,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':pkg}}));
await prepareScoringDependencies(dir);console.log(JSON.stringify(await scoreRun({hiddenTestCommand:['npm','test'],damageCommands:[]} as never,{workspaceDir:dir}),null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
