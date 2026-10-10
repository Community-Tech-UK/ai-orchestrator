/**
 * A portable, secret-free MiMo account sign-in command. OpenCode's auth picker
 * uses its models catalog, not custom provider config. Register only the new
 * account in a temporary catalog for this command; OpenCode still owns the
 * interactive key prompt and writes to its normal shared credential store.
 */
import {
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  opencodeAccountProviderName,
  type ProviderAccountProfile,
} from '../types/provider-account.types';

export function openCodeAccountLoginCommand(
  profile: Pick<ProviderAccountProfile, 'id' | 'isLegacy' | 'region'>,
): string {
  if (!PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(profile.id)) throw new Error('Invalid account profile ID');
  if (profile.region !== undefined && !['ams', 'sgp', 'cn'].includes(profile.region)) throw new Error('Invalid Token Plan region');
  if (profile.isLegacy && !profile.region) return 'opencode auth login';
  const providerName = opencodeAccountProviderName(profile);
  if (profile.isLegacy) return `opencode auth login -p ${providerName}`;
  // No provider model metadata is fabricated: auth accepts an empty catalog
  // model map. Runtime model definitions are still generated at session spawn.
  const catalog = { [providerName]: {
    id: providerName, name: providerName, env: [], npm: '@ai-sdk/openai-compatible', models: {},
  } };
  const script = [
    "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');",
    "const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-mimo-login-'));",
    "const cleanup=()=>{process.stdin.unpipe();process.stdin.pause();fs.rmSync(dir,{recursive:true,force:true});};",
    "try{const file=path.join(dir,'models.json');",
    `fs.writeFileSync(file,${JSON.stringify(JSON.stringify(catalog))},{mode:0o600});`,
    `const child=cp.spawn('opencode',['auth','login','-p',${JSON.stringify(providerName)}],`,
    "{stdio:[process.stdin.isTTY?'inherit':'pipe','inherit','inherit'],shell:process.platform==='win32',",
    "env:{...process.env,OPENCODE_MODELS_PATH:file,OPENCODE_DISABLE_MODELS_FETCH:'true'}});",
    "if(child.stdin){child.stdin.on('error',error=>{if(error.code!=='EPIPE')console.error(error.message);});process.stdin.pipe(child.stdin);}",
    "process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));",
    "child.once('error',error=>{cleanup();console.error(error.message);process.exitCode=1;});",
    "child.once('exit',(code,signal)=>{cleanup();",
    "process.exitCode=code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1);});",
    "}catch(error){cleanup();throw error;}",
  ].join('');
  // Base64 carries only this audited ASCII script. It prevents JSON/path
  // quoting from changing meaning across POSIX, cmd.exe and AppleScript.
  return `node -e "eval(Buffer.from('${btoa(script)}','base64').toString())"`;
}
