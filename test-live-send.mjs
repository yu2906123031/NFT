import {assertNoPending} from './journal.mjs';
import {readFile,open,unlink,writeFile} from 'node:fs/promises';
import {Wallet,Transaction,keccak256,formatEther,toQuantity} from 'ethers';
import {loadLocalEnv} from './env.mjs';
import {RpcPool} from './rpc-pool.mjs';
import {CHAIN,same,validateCost,broadcast,sleep} from './core.mjs';
const root=new URL('./',import.meta.url);
const record=new URL('live-send-test-result.json',root);
const lock=new URL('multi-run.lock',root);
const pool=new RpcPool({timeoutMs:5000,allowBroadcast:process.argv.includes('--live')});
let locked=false;
async function main(){
  if(!process.argv.includes('--live'))throw Error('Explicit --live required');
  const cfg=JSON.parse((await readFile(new URL('config.json',root),'utf8')).replace(/^\uFEFF/,''));
  const multi=JSON.parse((await readFile(new URL('multi-config.json',root),'utf8')).replace(/^\uFEFF/,''));
  const urls=[...new Set(multi.broadcastRpcs)];
  for(const url of [cfg.readRpc,...urls])if(new URL(url).protocol!=='https:')throw Error('HTTPS required');
  const handle=await open(lock,'wx');locked=true;await handle.close();
  await assertNoPending();
  try{await readFile(record);throw Error('Test record already exists; do not send again');}catch(e){if(e.code!=='ENOENT')throw e;}
  await loadLocalEnv();
  let wallet;try{wallet=new Wallet(process.env.MINT_PRIVATE_KEY||'');}catch{throw Error('Invalid local wallet key');}
  for(const k of Object.keys(process.env))if(k.startsWith('MINT_PRIVATE_KEY')||k==='PRIVATE_KEY')delete process.env[k];
  const address=wallet.address;
  if(!same(address,'0xae4154c083024820b5df3b15db6120141c32e8ca')||!same(address,cfg.walletAddress))throw Error('Wallet 1 address mismatch');
  const read=(method,params=[])=>pool.call(cfg.readRpc,method,params);
  const [chain,latest,pending,balance,price]=await Promise.all([
    read('eth_chainId'),read('eth_getTransactionCount',[address,'latest']),read('eth_getTransactionCount',[address,'pending']),read('eth_getBalance',[address,'latest']),read('eth_gasPrice')]);
  if(BigInt(chain)!==CHAIN)throw Error('Wrong chain');
  if(BigInt(latest)!==BigInt(pending))throw Error('Pending transaction exists');
  const fee=BigInt(price)*4n;
  const request={from:address,to:address,value:'0x0',data:'0x',maxFeePerGas:toQuantity(fee),maxPriorityFeePerGas:'0x0'};
  const estimate=BigInt(await read('eth_estimateGas',[request]));
  const gas=(estimate*130n+99n)/100n;
  const cap=validateCost(gas,fee,BigInt(balance),'0.0001');
  await read('eth_call',[{...request,gas:toQuantity(gas)},'latest']);
  const nonce=Number(BigInt(pending));
  if(!Number.isSafeInteger(nonce))throw Error('Invalid nonce');
  const raw=await wallet.signTransaction({type:2,chainId:CHAIN,to:address,value:0n,data:'0x',nonce,gasLimit:gas,maxFeePerGas:fee,maxPriorityFeePerGas:0n});
  wallet=null;
  const tx=Transaction.from(raw),hash=keccak256(raw);
  if(!same(tx.from,address)||!same(tx.to,address)||tx.value!==0n||tx.data!=='0x'||tx.chainId!==CHAIN)throw Error('Signed transaction verification failed');
  if(BigInt(await read('eth_getTransactionCount',[address,'pending']))!==BigInt(pending))throw Error('Nonce changed');
  const summary={hash,address,chainId:String(CHAIN),nonce,valueETH:'0',gasLimit:String(gas),maxFeePerGas:String(fee),maximumCostETH:formatEther(cap),createdAt:new Date().toISOString(),status:'PREPARED_BROADCAST_PENDING'};
  await writeFile(record,JSON.stringify(summary,null,2),{flag:'wx'});
  console.log(JSON.stringify(summary));
  const started=performance.now();
  const submissions=broadcast(urls,raw,hash,pool.call.bind(pool),(i,ok,ms)=>console.log(JSON.stringify({endpoint:i,accepted:ok,responseMs:ms})));
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    let receipt;
    try{receipt=await read('eth_getTransactionReceipt',[hash]);}catch{await sleep(500);continue;}
    if(receipt){
      await submissions;
      if(!same(receipt.transactionHash,hash)||!same(receipt.from,address)||!same(receipt.to,address))throw Error('Receipt mismatch');
      const result={...summary,status:BigInt(receipt.status)===1n?'INCLUDED':'REVERTED',blockNumber:String(BigInt(receipt.blockNumber)),gasUsed:String(BigInt(receipt.gasUsed)),effectiveGasPrice:String(BigInt(receipt.effectiveGasPrice)),executionFeeETH:formatEther(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)),observedAfterMs:Math.round(performance.now()-started),receipt};
      await writeFile(record,JSON.stringify(result,null,2));
      console.log(JSON.stringify(result));
      if(result.status!=='INCLUDED')process.exitCode=2;
      return;
    }
    await sleep(400);
  }
  await submissions;
  await writeFile(record,JSON.stringify({...summary,status:'UNKNOWN_CHECK_ORIGINAL_HASH'},null,2));
  throw Error('Receipt unknown; inspect saved hash, do not send another test');
}
main().catch(e=>{const m=String(e.message);console.error(m.length>180||/private|secret|0x[0-9a-f]{64}/i.test(m)?'Test failed; sensitive details suppressed':m);process.exitCode=1;}).finally(async()=>{pool.close();if(locked)await unlink(lock).catch(()=>{});});