import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
export function parseLocalEnv(source){
  const text=source.replace(/^\uFEFF/,'').trim();
  // Reject raw keys anywhere, including files mixing assignments and raw secrets.
  for(const line of text.split(/\r?\n/)){
    const value=line.trim();
    if(value&&!value.startsWith('#')&&!/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value))
      throw Error('Local env must contain KEY=value assignments; bare keys are not accepted');
  }
  return parseEnv(text);
}
export async function loadLocalEnv(){
  let source;
  for(const name of ['.env','.ENV']){
    try{source=await readFile(new URL(name,import.meta.url),'utf8');break;}
    catch(e){if(e.code!=='ENOENT')throw Error('Cannot read local env file');}
  }
  if(source){
    const values=parseLocalEnv(source);
    for(const k of ['MINT_PRIVATE_KEY','PRIVATE_KEY','WALLET_ADDRESS','READ_WS_RPC',...Array.from({length:6},(_,i)=>'MINT_PRIVATE_KEY_'+(i+1))])
      if(!process.env[k]&&values[k])process.env[k]=values[k];
  }
  process.env.MINT_PRIVATE_KEY ||= process.env.PRIVATE_KEY||'';
}
