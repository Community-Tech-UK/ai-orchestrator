import fs from 'node:fs';
import path from 'node:path';
import { prepareScoringDependencies } from '../../../scoring-setup.ts';
import { scoreRun } from '../../../scorer.ts';
const root=path.dirname(new URL(import.meta.url).pathname);
const dir=path.join(root,'native-scored-workspace');
const hostLock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
const esbuild=hostLock.packages['node_modules/esbuild'];
const pkg={name:'native-boundary-fixture',version:'1.0.0',dependencies:{esbuild:esbuild.version},scripts:{test:'esbuild fixture.js --bundle --platform=node --outfile=bundle.cjs && node bundle.cjs'}};
const packages={'':pkg,...Object.fromEntries(Object.entries(hostLock.packages).filter(([name])=>name==='node_modules/esbuild'||name.startsWith('node_modules/@esbuild/')))};
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(pkg));
fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages}));
fs.writeFileSync(path.join(dir,'fixture.js'),'import { z } from "zod"; console.log(z.string().parse("HOST_DEPENDENCY_LOADED"));');
try {
 const dependencies=await prepareScoringDependencies(dir,root+'/native-scored-setup');
 const workspaceHasZod=fs.existsSync(path.join(dir,'node_modules/zod'));
 const score=await scoreRun({hiddenTestCommand:['npm','test'],damageCommands:[]},{workspaceDir:dir,dependencies,logDir:root+'/native-scored-command'});
 const receipt={threw:false,workspaceHasZod,frozenDependencies:pkg.dependencies,score};
 fs.writeFileSync(path.join(root,'native-scored-outcome.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify({threw:false,workspaceHasZod,passed:score.hiddenTests.passed,exitCode:score.hiddenTests.exitCode}));
} catch(error) {fs.writeFileSync(path.join(root,'native-scored-outcome.json'),JSON.stringify({threw:true,error:String(error)},null,2)+'\n');console.log(String(error));}
finally {fs.rmSync(dir,{recursive:true,force:true});}
