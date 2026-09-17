import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {loadWallets,checkTotalBudget,dispatchGroups,fanout,waitUntil} from './multi-core.mjs';
import {RpcPool} from './rpc-pool.mjs';
const entry=(i,mode='clock')=>({label:'wallet'+i,keyEnv:'MINT_PRIVATE_KEY_'+i,mode});
test('six distinct keys load; missing, duplicate and mismatched keys are explicit',()=>{
  const entries=Array.from({length:6},(_,i)=>entry(i+1,i<3?'clock':'chain'));
  const env=Object.fromEntries(entries.map(e=>[e.keyEnv,Wallet.createRandom().privateKey]));
  assert.equal(loadWallets(entries,env).loaded.length,6);
  const missing={...env};delete missing.MINT_PRIVATE_KEY_6;
  assert.equal(loadWallets(entries,missing).issues[0].label,'wallet6');
  const duplicate={...env,MINT_PRIVATE_KEY_6:env.MINT_PRIVATE_KEY_1};
  assert.throws(()=>loadWallets(entries,duplicate),/Duplicate wallet/);
  const mismatch=[{...entries[0],address:Wallet.createRandom().address}];
  assert.equal(loadWallets(mismatch,env).issues[0].problem,'address mismatch');
  assert.equal(loadWallets([entries[0]],{MINT_PRIVATE_KEY_1:'wrong'}).issues[0].problem,'invalid private key format');
});
test('aggregate budget blocks six individually affordable plans',()=>{
  const plans=Array.from({length:6},()=>({cap:1000000000000000n}));
  assert.equal(checkTotalBudget(plans,'0.006'),6000000000000000n);
  assert.throws(()=>checkTotalBudget(plans,'0.005'),/Combined cost/);
});
test('clock group starts without waiting for chain, all wallets start without waiting for receipts',async()=>{
  let releaseClock,releaseChain;
  const clock=new Promise(r=>releaseClock=r),chain=new Promise(r=>releaseChain=r);
  const plans=Array.from({length:6},(_,i)=>({label:'w'+i,mode:i<3?'clock':'chain'}));
  const started=[],done=[];
  const task=dispatchGroups(plans,{clock:()=>clock,chain:()=>chain},p=>{
    started.push(p.label);return new Promise(r=>done.push(r));
  });
  releaseClock();await new Promise(r=>setImmediate(r));
  assert.deepEqual(started,['w0','w1','w2']);
  releaseChain();await new Promise(r=>setImmediate(r));
  assert.deepEqual(started,['w0','w1','w2','w3','w4','w5']);
  done.forEach(r=>r('ok'));
  const result=await task;
  assert.ok(result.every(r=>r.status==='fulfilled'));
});
test('chain gate failure does not prevent clock submission',async()=>{
  const sent=[];
  const result=await dispatchGroups([{mode:'clock',label:'c'},{mode:'chain',label:'b'}],
    {clock:async()=>{},chain:async()=>{throw Error('stale');}},async p=>sent.push(p.label));
  assert.deepEqual(sent,['c']);assert.equal(result[1].status,'rejected');
});
test('six wallets x three endpoints produce 18 concurrent attempts with one raw per wallet',async()=>{
  const plans=Array.from({length:6},(_,i)=>({label:'w'+i,raw:'raw'+i,hash:'0x'+String(i).repeat(64)}));
  const calls=[],finish=[];
  const rpc=(url,method,[raw])=>new Promise(resolve=>{calls.push({url,raw});finish.push(()=>resolve(plans.find(p=>p.raw===raw).hash));});
  const work=plans.map(p=>fanout(p,['a','b','c'],rpc,()=>{}));
  assert.equal(calls.length,18);
  for(const p of plans)assert.equal(calls.filter(c=>c.raw===p.raw).length,3);
  finish.forEach(fn=>fn());
  const results=await Promise.all(work);
  assert.ok(results.flat().every(r=>r.status==='fulfilled'));
});
test('read-only transport refuses signed broadcast before opening any socket',async()=>{
  const pool=new RpcPool();
  try{await assert.rejects(pool.call('https://invalid.example','eth_sendRawTransaction',['0x1234']),/disabled/);}
  finally{pool.close();}
});
test('clock wait does not fire early and avoids long timer overflow',async()=>{
  let now=0;const sleeps=[];
  await waitUntil(3200,()=>now,async ms=>{sleeps.push(ms);now+=ms;});
  assert.equal(now,3200);assert.ok(sleeps.every(x=>x<=1000));
});

test('synchronous wallet failure does not skip remaining wallets',async()=>{
  const sent=[];
  const result=await dispatchGroups([{mode:'clock',label:'a'},{mode:'clock',label:'b'}],
    {clock:async()=>{}},p=>{sent.push(p.label);if(p.label==='a')throw Error('failed');return 'ok';});
  assert.deepEqual(sent,['a','b']);
  assert.deepEqual(result[0].value.map(r=>r.status),['rejected','fulfilled']);
});