import {explorerEvidence} from './explorer.mjs';
import {readFile} from 'node:fs/promises';
import {RpcPool} from './rpc-pool.mjs';
import {createReadFallback} from './rpc-read.mjs';
import {readPending,savePending} from './journal.mjs';
import {acquireRunLock} from './run-lock.mjs';
import {CHAIN,SEA,NFT,abi,same} from './core.mjs';
import {ZeroAddress} from 'ethers';
const pool=new RpcPool();
let release;
try{
  release=await acquireRunLock(new URL('./multi-run.lock',import.meta.url));
  const base=JSON.parse(await readFile(process.env.MINT_CONFIG||new URL('./config.json',import.meta.url),'utf8'));
  const multi=JSON.parse(await readFile(process.env.MULTI_CONFIG||new URL('./multi-config.json',import.meta.url),'utf8'));
  const cfg={...base,...multi};
  const pending=await readPending();
  if(!pending.length)console.log('No unresolved recorded transactions.');
  else{
    const checks=await Promise.allSettled((cfg.readRpcs??[cfg.readRpc]).map(async url=>{
      if(BigInt(await pool.call(url,'eth_chainId'))!==CHAIN)throw Error('Wrong chain');
      return url;
    }));
    const urls=checks.filter(r=>r.status==='fulfilled').map(r=>r.value);
    if(!urls.length)throw Error('No verified read endpoint');
    const read=createReadFallback(urls,pool.call.bind(pool));
    const results=await Promise.all(pending.map(async p=>{
      const receipt=await read('eth_getTransactionReceipt',[p.hash]);
      if(!receipt||!same(receipt.from,p.address)||!same(receipt.to,SEA)){
        console.log({label:p.label,hash:p.hash,status:'UNKNOWN_NO_RESEND',explorer:'https://robinhoodchain.blockscout.com/tx/'+p.hash,explorerEvidence:await explorerEvidence(p)});
        return p;
      }
      // Confirm the recorded receipt belongs to the canonical block before clearing the guard.
      const block=await read('eth_getBlockByNumber',[receipt.blockNumber,false]);
      if(!same(block.hash,receipt.blockHash))return p;
      const mint=receipt.logs.filter(l=>same(l.address,NFT)).some(l=>{
        try{const event=abi.parseLog(l);return event?.name==='Transfer'&&same(event.args.from,ZeroAddress)&&same(event.args.to,p.address);}catch{return false;}
      });
      console.log({label:p.label,hash:p.hash,status:receipt.status==='0x0'?'REVERTED':mint?'MINT_INCLUDED_SOFT':'NO_EXPECTED_MINT_EVENT'});
      return null;
    }));
    const unresolved=results.filter(Boolean);
    await savePending(unresolved);
    if(unresolved.length)process.exitCode=2;
  }
}catch(e){console.error(e.message);process.exitCode=1;}
finally{pool.close();if(release)await release();}
