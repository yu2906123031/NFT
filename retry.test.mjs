import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,Transaction} from 'ethers';
import {prepareRetry,retryBudget} from './retry.mjs';
import {CHAIN,NFT,SEA,abi,mintData} from './core.mjs';
const fee='0x0000a26b00c1f0df003000390027140000faa719';
function fixture(overrides={}){
 const signer=Wallet.createRandom(),hash='0x'+'ab'.repeat(32),blockHash='0x'+'cd'.repeat(32);
 const cfg={expectedStartTime:1000,pollMs:100,maxGasBudgetEth:'0.001',gasPriceMultiplier:2};
 const plan={attempt:0,address:signer.address,hash,cap:420000000000n,tx:{type:2,chainId:CHAIN,to:SEA,data:mintData(fee),value:0n,nonce:2,gasLimit:420000n,maxFeePerGas:1000000n,maxPriorityFeePerGas:0n}};
 const receipt={status:'0x0',transactionHash:hash,from:signer.address,to:SEA,blockHash,blockNumber:'0xa'};
 const calls=[];
 const read=async(method,params=[])=>{
  calls.push({method,params});
  if(overrides[method])return overrides[method](params);
  if(method==='eth_getTransactionReceipt')return receipt;
  if(method==='eth_getBlockByNumber')return {number:'0xa',timestamp:'0x3e9',hash:blockHash};
  if(method==='eth_chainId')return '0x1237';
  if(method==='eth_getTransactionCount')return '0x3';
  if(method==='eth_getBalance')return '0xde0b6b3a7640000';
  if(method==='eth_gasPrice')return '0xf4240';
  if(method==='eth_call'){
   const parsed=abi.parseTransaction({data:params[0].data});
   const values={getAllowedSeaDrop:[[SEA]],getPublicDrop:[[0n,1000n,2000n,1n,0n,true]],getAllowedFeeRecipients:[[fee]],getMintStats:[0n,1n,10n]};
   if(parsed.name==='mintPublic')return '0x';
   return abi.encodeFunctionResult(parsed.name,values[parsed.name]);
  }
  throw Error('Unexpected RPC method');
 };
 return {plan,receipt,signer,read,cfg,now:()=>1001000,calls};
}
test('reverted Mint prepares exactly next nonce and checks current execution',async()=>{
 const f=fixture();const reserved=[];
 const p=await prepareRetry({...f,reserve:cap=>reserved.push(cap)});
 const tx=Transaction.from(p.raw);
 assert.equal(p.attempt,1);assert.equal(tx.nonce,3);assert.equal(tx.to.toLowerCase(),SEA);assert.equal(tx.data,f.plan.tx.data);assert.equal(tx.value,0n);
 assert.equal(reserved.length,1);
 assert.ok(f.calls.some(c=>c.method==='eth_call'&&c.params[1]==='latest'));
 await assert.rejects(prepareRetry({...f,plan:p}),/Only one retry/);
});
test('success, unknown receipt and mismatched hash cannot retry',async()=>{
 for(const change of [()=>null,r=>({...r,status:'0x1'}),r=>({...r,transactionHash:'0x00'})]){
  const f=fixture();await assert.rejects(prepareRetry({...f,receipt:change(f.receipt)}),/original reverted/);
  assert.equal(f.calls.length,0);
 }
});
test('pending transaction, reorg and unknown original stop retry',async()=>{
 for(const overrides of [
  {eth_getTransactionCount:()=> '0x4'},
  {eth_getTransactionReceipt:()=>null},
  {eth_getBlockByNumber:()=>({hash:'0x00'})}
 ])await assert.rejects(prepareRetry(fixture(overrides)),/nonce|receipt changed|block changed/);
});
test('sold out and wallet limit block retry before signing',async()=>{
 for(const stats of [[0n,10n,10n],[1n,1n,10n]]){
  const f=fixture(),read=f.read;
  f.read=async(m,p)=>m==='eth_call'&&abi.parseTransaction({data:p[0].data}).name==='getMintStats'?abi.encodeFunctionResult('getMintStats',stats):read(m,p);
  await assert.rejects(prepareRetry(f),/Sold out|Wallet mint limit/);
 }
});
test('simulation failure and cumulative wallet budget prevent retry',async()=>{
 const f=fixture(),read=f.read;
 f.read=async(m,p)=>{if(m==='eth_call'&&p[1]==='latest')throw Error('simulation reverted');return read(m,p);};
 await assert.rejects(prepareRetry(f),/simulation reverted/);
 const g=fixture();g.plan.cap=999999999999999n;
 await assert.rejects(prepareRetry(g),/plus retry exceeds/);
});
test('early revert waits for opening block before simulating',async()=>{
 const f=fixture();let clock=999000,latestCalls=0;const read=f.read;
 f.now=()=>clock;f.pause=async ms=>{clock+=ms;};
 f.read=async(m,p)=>{
  if(m==='eth_getBlockByNumber'&&p[0]==='latest'){
   latestCalls++;return {number:'0xa',timestamp:'0x'+Math.floor(clock/1000).toString(16)};
  }
  return read(m,p);
 };
 await prepareRetry(f);assert.ok(latestCalls>1);assert.ok(clock>=1000000);
});
test('aggregate reservation prevents parallel retries exceeding original budget',async()=>{
 const reserve=retryBudget([400000000000000n],'0.001');
 const results=await Promise.allSettled([1,2].map(async()=>reserve(400000000000000n)));
 assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);
});