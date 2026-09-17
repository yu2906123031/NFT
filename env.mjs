import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
export async function loadLocalEnv(){
let source;
for(const name of ['.env','.ENV']){
try{source=(await readFile(new URL(name,import.meta.url),'utf8')).trim();break;}
catch(e){if(e.code!=='ENOENT')throw Error('Cannot read local env file');}
}
if(!source)return;
const values=/^(0x)?[a-fA-F0-9]{64}$/.test(source)?{MINT_PRIVATE_KEY:source.startsWith('0x')?source:'0x'+source}:parseEnv(source);
for(const k of ['MINT_PRIVATE_KEY','PRIVATE_KEY','WALLET_ADDRESS',...Array.from({length:6},(_,i)=>'MINT_PRIVATE_KEY_'+(i+1))])if(!process.env[k]&&values[k])process.env[k]=values[k];
process.env.MINT_PRIVATE_KEY ||= process.env.PRIVATE_KEY||'';
}
