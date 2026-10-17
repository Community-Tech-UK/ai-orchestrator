/**
 * Portable MiMo sign-in commands using OpenCode's normal shared credential store.
 * Version 1 owns its key prompt; new named profiles use a temporary model catalog.
 * Named version 2 accounts use hidden terminal input and stdin-only auth import.
 * The legacy profile without a known region keeps OpenCode's native provider picker.
 */
import {
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  opencodeAccountProviderName,
  type ProviderAccountProfile,
} from '../types/provider-account.types';
import { supportedOpenCodeMajor } from './opencode-supported-version';

export interface OpenCodeLoginSelection { command: string; major: number }

/** Fixed auth arguments carry no user text; quote npm shims before cmd.exe sees paths. */
export function openCodeLoginSpawnTarget(command: string, platform: string): { command: string; shell: boolean } {
  const shell = platform === 'win32' && !command.toLowerCase().endsWith('.exe');
  if (shell && /["%\r\n\0]/.test(command)) throw new Error('Unsafe OpenCode command path');
  return { command: shell ? `"${command}"` : command, shell };
}

function encodeScript(script: string): string {
  return `node -e "eval(Buffer.from('${btoa(script.split('').map((char) => char.charCodeAt(0) > 127 ? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0') : char).join(''))}','base64').toString())"`;
}

/**
 * Keys use hidden input and import stdin. Native import leaves replacements
 * inactive, so deliberate key entry also switches and verifies the exact ID.
 * Legacy copying never switches over a credential added concurrently.
 */
function v2LoginScript(provider: string, command: string, commandExpression?: string): string {
  const script = [
    `const target=targetFor(${commandExpression ?? JSON.stringify(command)},process.platform),command=target.command,provider=${JSON.stringify(provider)};`,
    "const run=(args,input,env)=>{if(cp.spawnSync(command,args,{input,env,stdio:['pipe','ignore','ignore'],shell:target.shell,windowsHide:true,timeout:30000}).status!==0)throw Error();};",
    "const imp=(key,replace=true)=>{const id='aio-'+require('node:crypto').randomUUID();let env=process.env;if(replace){const c=JSON.parse(env.OPENCODE_CONFIG_CONTENT||'{}'),p=c?.providers===undefined?{}:c.providers;if(![c,p,p?.[provider]===undefined?{}:p[provider]].every(v=>v&&typeof v==='object'&&!Array.isArray(v)))throw Error();env={...env,OPENCODE_CONFIG_CONTENT:JSON.stringify({...c,providers:{...p,[provider]:{...p[provider],activation:'enabled'}}})};}",
    "run(['auth','import','--standalone'],JSON.stringify([{id,integrationID:provider,label:'API key',active:true,value:{type:'key',key}}]),env);if(replace)run(['auth','switch',provider,id,'--standalone'],undefined,env);if(!has(id))throw Error();};",
    "const read=prompt=>new Promise(resolve=>{process.stdout.write(prompt);let value='';const raw=process.stdin.isTTY; if(raw)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();",
    "const finish=()=>{process.stdin.removeListener('data',onData);if(raw)process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\\n');resolve(value.trim());};",
    "const onData=data=>{for(const ch of data){if(ch==='\\r'||ch==='\\n'){finish();return;}if(ch==='\\u0003'){if(raw)process.stdin.setRawMode(false);process.exit(130);}if(ch==='\\u007f'||ch==='\\b')value=value.slice(0,-1);else value+=ch;}};process.stdin.on('data',onData);process.stdin.once('end',finish);});",
    "const has=id=>{let d;try{const f=process.env.OPENCODE_DB?.trim()||path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'),'opencode','opencode.db');try{fs.statSync(f)}catch(e){if(e.code==='ENOENT')return false;throw e;}d=new(require('node:sqlite').DatabaseSync)(f,{readOnly:true,timeout:1000,allowExtension:false});return !!d.prepare('SELECT integration_id FROM credential WHERE integration_id=?'+(id?' AND id=? AND active=1':'')+' LIMIT 1').get(...(id?[provider,id]:[provider]));}catch{throw Error(id?'Credential verification failed.':'Unable to read OpenCode 2 credentials. Nothing was copied.');}finally{d?.close();}};",
    "(async()=>{let old;try{const home=process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share');const file=path.join(home,'opencode','auth.json');if(fs.statSync(file).size<=262144){const entry=JSON.parse(fs.readFileSync(file,'utf8'))[provider];if(entry&&entry.type==='api'&&typeof entry.key==='string'&&entry.key)old=entry.key;}}catch{}",
    "if(old&&!has()){const answer=await read('A legacy key exists for '+provider+'. Copy it into OpenCode 2? Type yes to copy, or press Enter to enter a new key: ');if(answer==='yes'){if(has()){console.log('Credential already exists; legacy key not copied.');return;}await imp(old,false);console.log('Copied '+provider+' into OpenCode 2.');return;}}",
    "const key=await read('Paste the MiMo key for '+provider+' (hidden): ');if(!key)throw Error('No key entered.');await imp(key);console.log('Signed in as '+provider+'.');})().catch(e=>{console.error(e?.message==='Unable to read OpenCode 2 credentials. Nothing was copied.'?e.message:'OpenCode sign-in failed. No key was displayed.');process.exitCode=1;});",
  ].join('');
  return script;
}

export function openCodeAccountLoginCommand(
  profile: Pick<ProviderAccountProfile, 'id' | 'isLegacy' | 'region'>,
  selected?: OpenCodeLoginSelection,
): string {
  if (!PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(profile.id)) throw new Error('Invalid account profile ID');
  if (profile.region !== undefined && !['ams', 'sgp', 'cn'].includes(profile.region)) throw new Error('Invalid Token Plan region');
  if (selected && selected.major !== 1 && selected.major !== 2) throw new Error('Unsupported OpenCode major');
  const prelude = [
    `const targetFor=${openCodeLoginSpawnTarget.toString()};`,
    "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');",
    `const choices=${JSON.stringify(selected ? [selected.command] : ['opencode2', 'opencode'])}.flatMap(command=>{const target=targetFor(command,process.platform);const result=cp.spawnSync(target.command,['--version'],{encoding:'utf8',shell:target.shell,windowsHide:true,timeout:5000,maxBuffer:65536});const major=(${supportedOpenCodeMajor.toString()})(result.status===0?String(result.stdout):'');return major?[{command,major}]:[];});`,
    selected ? `const chosen=choices.find(row=>row.major===${selected.major});` : "const chosen=choices.find(row=>row.major===2)||choices.find(row=>row.major===1);",
    "if(!chosen)throw Error('No supported OpenCode command found. Install OpenCode 2.0.30 or newer.');",
  ].join('');
  const login = (args: string) => `const target=targetFor(chosen.command,process.platform);const child=cp.spawn(target.command,${args},{stdio:'inherit',shell:target.shell});child.on('error',()=>process.exitCode=1);child.on('close',code=>process.exitCode=code??1);`;
  if (profile.isLegacy && !profile.region) return encodeScript(prelude + login("chosen.major===2?['auth','login','--standalone']:['auth','login']"));
  const providerName = opencodeAccountProviderName(profile);
  // A pinned 2.x selection has already been rechecked above. Omitting the
  // unreachable 1.x catalog keeps long Windows paths inside cmd.exe's limit.
  if (selected?.major === 2) return encodeScript(prelude + v2LoginScript(providerName, 'opencode', 'chosen.command'));
  const v2 = `if(chosen.major===2){${v2LoginScript(providerName, 'opencode', 'chosen.command')}}else{`;
  if (profile.isLegacy) return encodeScript(prelude + v2 + login(JSON.stringify(['auth', 'login', '-p', providerName])) + '}');
  // No provider model metadata is fabricated: auth accepts an empty catalog
  // model map. Runtime model definitions are still generated at session spawn.
  const script = [
    prelude, v2,
    `const provider=${JSON.stringify(providerName)},catalog={[provider]:{id:provider,name:provider,env:[],npm:'@ai-sdk/openai-compatible',models:{}}};`,
    "const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-mimo-login-'));",
    "const cleanup=()=>{process.stdin.unpipe();process.stdin.pause();fs.rmSync(dir,{recursive:true,force:true});};",
    "try{const file=path.join(dir,'models.json');",
    'fs.writeFileSync(file,JSON.stringify(catalog),{mode:0o600});',
    "const target=targetFor(chosen.command,process.platform);const child=cp.spawn(target.command,['auth','login','-p',provider],",
    "{stdio:[process.stdin.isTTY?'inherit':'pipe','inherit','inherit'],shell:target.shell,",
    "env:{...process.env,OPENCODE_MODELS_PATH:file,OPENCODE_DISABLE_MODELS_FETCH:'true'}});",
    "if(child.stdin){child.stdin.on('error',error=>{if(error.code!=='EPIPE')console.error(error.message);});process.stdin.pipe(child.stdin);}",
    "process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));",
    "child.once('error',error=>{cleanup();console.error(error.message);process.exitCode=1;});",
    "child.once('exit',(code,signal)=>{cleanup();",
    "process.exitCode=code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1);});",
    "}catch(error){cleanup();throw error;}",
    "}",
  ].join('');
  // Base64 carries only this audited ASCII script. It prevents JSON/path
  // quoting from changing meaning across POSIX, cmd.exe and AppleScript.
  return encodeScript(script);
}
