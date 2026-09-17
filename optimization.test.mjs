import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocalEnv} from './env.mjs';
import {HeadWatcher} from './head-watcher.mjs';
import {runtimeOptions,checkRetryReserve,pinStartTime,receiptMetrics} from './runtime.mjs';
import {broadcast,CHAIN} from './core.mjs';
import {selectWallets} from './multi-core.mjs';
const hash='0x'+'ab'.repeat(32);
const block=(timestamp=1000,number=1)=>({number:'0x'+number.toString(16),timestamp:'0x'+timestamp.toString(16),hash});
test('env refuses raw secrets mixed into a file without revealing them',()=>{
  const secret='a'.repeat(64);
  for(const source of [secret,'MINT_PRIVATE_KEY=x\n'+secret,'export '+secret])
    assert.throws(()=>parseLocalEnv(source),e=>!e.message.includes(secret)&&/KEY=value/.test(e.message));
  assert.equal(parseLocalEnv('# local\nMINT_PRIVATE_KEY=example\nREAD_WS_RPC=wss://example.invalid').MINT_PRIVATE_KEY,'example');
});
test('resolved on-chain start is pinned for all subsequent checks and retries',()=>{
  const cfg={autoStartTime:true,expectedStartTime:1};
  assert.equal(pinStartTime(cfg,{startTime:1000n}),1000000);
  assert.equal(cfg.expectedStartTime,1000);assert.equal(cfg.autoStartTime,false);
  assert.throws(()=>pinStartTime(cfg,{startTime:1001n}),/Start time changed/);
});
test('reserve checks combined and wallet budgets and available balance',()=>{
  const cfg={reserveRetryBudget:true,maxGasBudgetEth:'0.001',totalGasBudgetEth:'0.001'};
  const p={label:'a',cap:400000000000000n,balance:1000000000000000n};
  assert.doesNotThrow(()=>checkRetryReserve([p],cfg));
  assert.throws(()=>checkRetryReserve([p,p],cfg),/Combined/);
  assert.throws(()=>checkRetryReserve([{...p,cap:600000000000000n}],cfg),/retry budget/);
  assert.throws(()=>checkRetryReserve([{...p,balance:p.cap}],cfg),/Balance/);
});
test('partial wallets skips only missing keys and enforces configured quorum',()=>{
  const result={loaded:[{}],issues:[{kind:'missing'}]};
  assert.equal(selectWallets(result,{allowPartialWallets:true}).length,1);
  assert.throws(()=>selectWallets(result,{allowPartialWallets:false}),/All enabled/);
  assert.throws(()=>selectWallets(result,{allowPartialWallets:true,minReadyWallets:2}),/Not enough/);
  assert.throws(()=>selectWallets({...result,issues:[{problem:'address mismatch'}]},{allowPartialWallets:true}),/Invalid wallet/);
});
test('accepted or already-known routes do not let nonce-too-low imply success',async()=>{
  const records=[];
  const result=await broadcast(['known','nonce','ok'],'bytes',hash,async url=>{
    if(url==='ok')return hash;
    throw Object.assign(Error('controlled'),{broadcastStatus:url==='known'?'already_known':'nonce_too_low'});
  },(i,ok,ms,status)=>records.push({i,ok,status}));
  assert.deepEqual(result.map(r=>r.status),['fulfilled','rejected','fulfilled']);
  assert.equal(records.find(r=>r.i===1).ok,false);
});
test('opening watcher ignores fast pre-sale response and uses ready backup',async()=>{
  const watcher=new HeadWatcher({urls:['fast','ready'],now:()=>1000000,
    rpc:async url=>block(url==='fast'?999:1000)});
  try{
    const result=await watcher.waitForOpen(1000n,2000n,500);
    assert.equal(result.source,'http');assert.equal(result.block.timestamp,'0x3e8');
  }finally{watcher.close();}
});
test('HTTP watcher keeps polling healthy endpoint while another remains stalled',async()=>{
  let calls=0,release;
  const slow=new Promise(r=>release=r);
  const watcher=new HeadWatcher({urls:['slow','healthy'],pollMs:5,now:()=>1000000,
    rpc:async url=>url==='slow'?slow:block(++calls<2?999:1000)});
  try{await watcher.waitForOpen(1000n,2000n,200);assert.ok(calls>=2);}
  finally{release(block());watcher.close();}
});
test('stale, malformed and pre-sale heads never trigger; timeout is bounded',async()=>{
  const watcher=new HeadWatcher({urls:['bad'],now:()=>1000000,pollMs:5,rpc:async()=>block(1)});
  try{await assert.rejects(watcher.waitForOpen(1000n,2000n,25),/deadline/);}
  finally{watcher.close();}
});
class FakeSocket extends EventTarget{
  static instances=[];
  constructor(){super();this.sent=[];FakeSocket.instances.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(raw){this.sent.push(JSON.parse(raw));}
  message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
  close(){this.closed=true;this.dispatchEvent(new Event('close'));}
}
test('WSS requires correct chain, subscription id and valid opening head',async()=>{
  const watcher=new HeadWatcher({urls:[],wsUrl:'wss://example.invalid',WebSocketImpl:FakeSocket,now:()=>1000000}).start();
  try{
    await new Promise(r=>setImmediate(r));
    const ws=FakeSocket.instances.at(-1);
    assert.equal(ws.sent[0].method,'eth_chainId');
    ws.message({jsonrpc:'2.0',id:ws.sent[0].id,result:'0x'+CHAIN.toString(16)});
    assert.equal(ws.sent[1].method,'eth_subscribe');
    ws.message({jsonrpc:'2.0',id:ws.sent[1].id,result:'subscription'});
    const waiting=watcher.waitForOpen(1000n,2000n,200);
    ws.message({jsonrpc:'2.0',method:'eth_subscription',params:{subscription:'wrong',result:block()}});
    assert.equal(watcher.latest,undefined);
    ws.message({jsonrpc:'2.0',method:'eth_subscription',params:{subscription:'subscription',result:block()}});
    assert.equal((await waiting).source,'wss');
  }finally{watcher.close();}
});
test('wrong-chain websocket is closed and HTTP backup remains usable',async()=>{
  const watcher=new HeadWatcher({urls:['http'],rpc:async()=>block(),wsUrl:'wss://example.invalid',WebSocketImpl:FakeSocket,now:()=>1000000}).start();
  try{
    await new Promise(r=>setImmediate(r));const ws=FakeSocket.instances.at(-1);
    ws.message({jsonrpc:'2.0',id:ws.sent[0].id,result:'0x1'});
    assert.equal(ws.closed,true);
    assert.equal((await watcher.waitForOpen(1000n,2000n,200)).source,'http');
  }finally{watcher.close();}
});
test('runtime validates timing options and reports L1 gas only when supplied',()=>{
  assert.throws(()=>runtimeOptions({sendOffsetMs:-5000}),/sendOffsetMs/);
  assert.throws(()=>runtimeOptions({reserveRetryBudget:'false'}),/reserveRetryBudget/);
  assert.deepEqual(receiptMetrics({blockNumber:'0x10',transactionIndex:'0x0',gasUsed:'0x64'}),
    {blockNumber:'16',transactionIndex:'0',gasUsed:'100',gasUsedForL1:null,effectiveGasPrice:null});
});


test('websocket close does not disable the opening-block HTTP fallback',async()=>{
  const watcher=new HeadWatcher({urls:['http'],rpc:async()=>block(),wsUrl:'wss://example.invalid',WebSocketImpl:FakeSocket,now:()=>1000000}).start();
  try{
    await new Promise(r=>setImmediate(r));FakeSocket.instances.at(-1).close();
    assert.equal((await watcher.waitForOpen(1000n,2000n,200)).source,'http');
  }finally{watcher.close();}
});
test('same watcher returns one shared wait promise and rejects on shutdown',async()=>{
  const watcher=new HeadWatcher({urls:[],now:()=>1000000});
  const one=watcher.waitForOpen(1000n,2000n,500),two=watcher.waitForOpen(1000n,2000n,500);
  assert.equal(one,two);watcher.close();await assert.rejects(one,/closed/);
});
test('pending journal stores only public identifiers, blocks restart and clears atomically',async()=>{
  const {mkdtemp,rmdir,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {pathToFileURL}=await import('node:url');const {createJournal}=await import('./journal.mjs');
  const dir=await mkdtemp(join(tmpdir(),'mint-journal-'));
  const journal=createJournal(pathToFileURL(dir+'/'));
  try{
    await journal.assertNoPending();
    await journal.savePending([{label:'a',address:'public',hash,raw:'SECRET_RAW',privateKey:'SECRET_KEY',tx:{nonce:3}}]);
    const text=await readFile(join(dir,'pending-mints.json'),'utf8');
    assert.ok(!text.includes('SECRET'));
    await assert.rejects(journal.assertNoPending(),/Unresolved/);
    assert.deepEqual(await journal.readPending(),[{label:'a',address:'public',hash,nonce:3}]);
    await journal.savePending([]);await journal.assertNoPending();assert.deepEqual(await journal.readPending(),[]);
  }finally{await rmdir(dir);}
});
test('explorer evidence validates hash, sender and destination, never grants mint status',async()=>{
  const {explorerEvidence}=await import('./explorer.mjs');const {SEA}=await import('./core.mjs');
  const address='0x'+'12'.repeat(20),plan={hash,address};
  const data={hash,from:{hash:address},to:{hash:SEA},status:'ok',block_number:7};
  const fetcher=async()=>({ok:true,json:async()=>data});
  assert.deepEqual(await explorerEvidence(plan,fetcher),{status:'INDEXED_SUCCESS',blockNumber:7});
  data.hash='0x'+'cd'.repeat(32);
  assert.equal((await explorerEvidence(plan,fetcher)).status,'MISMATCH');
  assert.equal((await explorerEvidence(plan,async()=>{throw Error('offline');})).status,'UNAVAILABLE');
});
