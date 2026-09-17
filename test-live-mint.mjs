import {acquireRunLock} from './run-lock.mjs';
import {assertNoPending} from './journal.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {Wallet,Transaction,keccak256,formatEther,toQuantity,Interface} from 'ethers';
import {loadLocalEnv} from './env.mjs';
import {RpcPool} from './rpc-pool.mjs';
import {CHAIN,NFT,SEA,abi,mintData,validateState,same,validateCost,broadcast,sleep} from './core.mjs';
const root=new URL('./',import.meta.url);
const record=new URL('live-mint-test-result.json',root);
const pool=new RpcPool({timeoutMs:5000,allowBroadcast:process.argv.includes('--live')});
let releaseLock;
async function main(){
  if(!process.argv.includes('--live'))throw Error('Explicit --live required');
  releaseLock=await acquireRunLock(new URL('multi-run.lock',root));
  await assertNoPending();
  const cfg=JSON.parse((await readFile(new URL('config.json',root),'utf8')).replace(/^\uFEFF/,''));
  const multi=JSON.parse((await readFile(new URL('multi-config.json',root),'utf8')).replace(/^\uFEFF/,''));
  const urls=[...new Set(multi.broadcastRpcs)];
  for(const url of [cfg.readRpc,...urls])if(new URL(url).protocol!=='https:')throw Error('HTTPS required');
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
  const block=await read('eth_getBlockByNumber',['latest',false]);
  const call=async(to,name,args)=>abi.decodeFunctionResult(name,await read('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block.number]));
  const [allowed,drop,fees,stats]=await Promise.all([call(NFT,'getAllowedSeaDrop',[]),call(SEA,'getPublicDrop',[NFT]),call(SEA,'getAllowedFeeRecipients',[NFT]),call(NFT,'getMintStats',[address])]);
  const state={chain:BigInt(chain),now:BigInt(block.timestamp),allowed:allowed[0],drop:drop[0],fees:fees[0],userMinted:stats[0],minted:stats[1],maximum:stats[2]};
  validateState(state,cfg);
  if(state.now>=state.drop.startTime)throw Error('Pre-opening test only; sale has started');
  const data=mintData(state.fees[0]);
  const gas=BigInt(cfg.gasLimit);
  const cap=validateCost(gas,fee,BigInt(balance),'0.0001');
  const request={from:address,to:SEA,value:'0x0',data,gas:toQuantity(gas)};
  let expectedRevert=false;
  const errors=new Interface(['error NotActive(uint256 currentTimestamp,uint256 startTimestamp,uint256 endTimestamp)']);
  try{await read('eth_call',[request,'latest']);}catch(e){
    let decoded;try{decoded=errors.parseError(e.data);}catch{}
    if(decoded?.name!=='NotActive')throw Error('Unexpected Mint simulation failure; abort');
    expectedRevert=true;
    console.log('Current Mint simulation: NotActive; user-authorized pre-opening revert test');
  }
  if(!expectedRevert)throw Error('Expected pre-opening revert absent; abort');
  const future=await read('eth_call',[request,block.number,{}, {time:toQuantity(state.drop.startTime+1n)}]);
  if(future!=='0x')throw Error('Future execution simulation failed');
  console.log('Opening-time simulation passed with configured gas limit');
  const nonce=Number(BigInt(pending));
  if(!Number.isSafeInteger(nonce))throw Error('Invalid nonce');
  const raw=await wallet.signTransaction({type:2,chainId:CHAIN,to:SEA,value:0n,data,nonce,gasLimit:gas,maxFeePerGas:fee,maxPriorityFeePerGas:0n});
  wallet=null;
  const tx=Transaction.from(raw),hash=keccak256(raw);
  if(!same(tx.from,address)||!same(tx.to,SEA)||tx.value!==0n||tx.data!==data||tx.chainId!==CHAIN)throw Error('Signed transaction verification failed');
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
      const responses=await submissions;
      const endpoints=responses.map((r,i)=>({endpoint:i,host:new URL(urls[i]).hostname,status:r.status,code:r.reason?.code??null,error:r.status==='rejected'?r.reason?.message:null}));
      console.log(JSON.stringify({endpoints}));
      if(!same(receipt.transactionHash,hash)||!same(receipt.from,address)||!same(receipt.to,SEA))throw Error('Receipt mismatch');
      const result={...summary,endpoints,status:BigInt(receipt.status)===1n?'INCLUDED':'REVERTED',blockNumber:String(BigInt(receipt.blockNumber)),gasUsed:String(BigInt(receipt.gasUsed)),effectiveGasPrice:String(BigInt(receipt.effectiveGasPrice)),executionFeeETH:formatEther(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)),observedAfterMs:Math.round(performance.now()-started),receipt};
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
main().catch(e=>{const m=String(e.message);console.error(m.length>180||/private|secret|0x[0-9a-f]{64}/i.test(m)?'Test failed; sensitive details suppressed':m);process.exitCode=1;}).finally(async()=>{pool.close();if(releaseLock)await releaseLock();});