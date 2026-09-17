// Single wallet uses the same transport, preparation, watcher and lock as multi-wallet.
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {checkSale} from './sale-status.mjs';
const command=process.argv[2]??'check';
try{
  if(!['check','bench','run'].includes(command))throw Error('Usage: node mint.mjs check|bench|run [--live]');
  if(command==='check'||(command==='run'&&!process.argv.includes('--live')))await checkSale();
  else{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./multi-mint.mjs',import.meta.url)),...process.argv.slice(2)],
      {env:{...process.env,MINT_SINGLE:'1'},stdio:'inherit',windowsHide:true});
    child.on('error',()=>{console.error('Unable to start mint process');process.exitCode=1;});
    child.on('exit',code=>{process.exitCode=code??1;});
  }
}catch(e){console.error(e.message);process.exitCode=1;}
