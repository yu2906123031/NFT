import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReadFallback} from './rpc-read.mjs';
import {acquireRunLock} from './run-lock.mjs';
const hash='0x'+'ab'.repeat(32),blockHash='0x'+'cd'.repeat(32),address='0x'+'12'.repeat(20);
const receipt={transactionHash:hash,blockHash,blockNumber:'0x1',status:'0x1',from:address,to:address,logs:[]};
test('null primary receipt cannot hide backup inclusion',async()=>{
 const read=createReadFallback(['a','b'],async url=>url==='a'?null:receipt);
 assert.deepEqual(await read('eth_getTransactionReceipt',[hash]),receipt);
});
test('receipt winner does not wait for stalled primary',async()=>{
 let release;
 const slow=new Promise(r=>release=r);
 const read=createReadFallback(['a','b'],url=>url==='a'?slow:Promise.resolve(receipt));
 try{assert.deepEqual(await read('eth_getTransactionReceipt',[hash]),receipt);}finally{release(null);}
});
test('wrong hash and malformed logs fail over to valid receipt',async()=>{
 for(const bad of [{...receipt,transactionHash:blockHash},{...receipt,logs:[{}]},{...receipt,status:'0x2'}]){
  const read=createReadFallback(['a','b'],async url=>url==='a'?bad:receipt);
  assert.deepEqual(await read('eth_getTransactionReceipt',[hash]),receipt);
 }
});
test('all absent or failed receipts stay unknown',async()=>{
 const read=createReadFallback(['a','b'],async url=>{if(url==='a')throw Error('offline');return null;});
 assert.equal(await read('eth_getTransactionReceipt',[hash]),null);
});
test('stale block and invalid quantity use backup',async()=>{
 const block={number:'0x1',timestamp:'0x3e8',hash:blockHash};
 const read=createReadFallback(['a','b'],async(url,method)=>method==='eth_gasPrice'?(url==='a'?null:'0x1'):(url==='a'?{...block,timestamp:'0x1'}:block),{now:()=>1000000});
 assert.deepEqual(await read('eth_getBlockByNumber',['latest',false]),block);
 assert.equal(await read('eth_gasPrice'),'0x1');
});
test('all failed reads stop without fabricating a value',async()=>{
 const read=createReadFallback(['a','b'],async()=>{throw Error('offline');});
 await assert.rejects(read('eth_getBalance',[address,'latest']),/All read endpoints failed/);
});
test('shared lock rejects concurrent live process and releases cleanly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mint-lock-'));const path=join(dir,'multi-run.lock');let release;
 try{
  release=await acquireRunLock(path);
  await assert.rejects(acquireRunLock(path),/Cannot acquire/);
  await release();await release();
  release=await acquireRunLock(path);
 }finally{if(release)await release();await rmdir(dir);}
});