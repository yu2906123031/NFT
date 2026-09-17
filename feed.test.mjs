import test from 'node:test';
import assert from 'node:assert/strict';
import {SequencerFeed,decodeFeedFrame,matchingFeedHead,createFeedVerifier,OFFICIAL_FEED} from './sequencer-feed.mjs';
import {HeadWatcher} from './head-watcher.mjs';
import {summarize,measureLocalTimers,recordArrival,compareArrivals,recommendSendTimeout} from './latency.mjs';
const hash='0x'+'ab'.repeat(32),otherHash='0x'+'cd'.repeat(32);
const head=(number=100,timestamp=1000)=>({number:'0x'+number.toString(16),timestamp:'0x'+timestamp.toString(16),hash});
const entry=(number=100,timestamp=1000)=>({sequenceNumber:number,blockHash:hash,signatureV2:'present',
  message:{message:{header:{kind:3,blockNumber:999999,timestamp}}}});
const frame=(...messages)=>JSON.stringify({version:1,messages});
const tick=()=>new Promise(r=>setImmediate(r));
class Socket extends EventTarget{
  static all=[];
  constructor(url){super();this.url=url;this.sent=[];Socket.all.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  message(text){this.dispatchEvent(new MessageEvent('message',{data:text}));}
  send(raw){this.sent.push(raw);}
  close(){this.closed=true;this.dispatchEvent(new Event('close'));}
}
test('feed uses L2 sequence instead of L1 header block number; filters backlog and future heads',()=>{
  const result=decodeFeedFrame(frame(entry(100,990),entry(101,1000),entry(102,1010)),{now:1000000});
  assert.deepEqual(result.heads,[head(101)]);assert.equal(result.stale,2);
  for(const bad of [{...entry(),sequenceNumber:Number.MAX_SAFE_INTEGER+1},{...entry(),blockHash:'bad'}])
    assert.equal(decodeFeedFrame(frame(bad),{now:1000000}).invalid,1);
  assert.throws(()=>decodeFeedFrame('{"version":2,"messages":[]}'),/envelope/);
  assert.throws(()=>decodeFeedFrame(new Uint8Array()),/size/);
});
test('RPC anchor must match both the L2 hash and timestamp',()=>{
  assert.ok(matchingFeedHead(head(),head()));
  assert.equal(matchingFeedHead(head(),{...head(),hash:otherHash}),false);
  assert.equal(matchingFeedHead(head(),head(100,1001)),false);
  assert.equal(matchingFeedHead(head(),head(101)),false);
});
test('official feed cannot trigger before anchor, then does not query RPC for every head',async()=>{
  let release,verifications=0;const received=[];
  const feed=new SequencerFeed({WebSocketImpl:Socket,now:()=>1000000,
    verify:()=>{verifications++;return new Promise(r=>release=r);},onHead:h=>received.push(h)});
  feed.start();await tick();const ws=Socket.all.at(-1);
  try{
    assert.equal(ws.url,OFFICIAL_FEED);assert.equal(ws.sent.length,0);
    ws.message(frame(entry()));await tick();assert.equal(received.length,0);
    ws.message(frame(entry(101)));release(true);await tick();
    assert.equal(received[0].number,'0x65');assert.equal(verifications,1);
    ws.message(frame(entry(102)));assert.equal(received.length,2);assert.equal(verifications,1);
    ws.message(frame(entry(101)));assert.equal(received.length,2);
    ws.message(frame(entry(103,999)));assert.equal(received.length,2);
  }finally{feed.close();}
});
test('failed anchor and old backlog never become trusted',async()=>{
  const received=[];
  const feed=new SequencerFeed({WebSocketImpl:Socket,now:()=>1000000,verify:async()=>false,onHead:h=>received.push(h)}).start();
  await tick();const ws=Socket.all.at(-1);
  try{
    ws.message(frame(entry(99,1)));ws.message(frame(entry()));await tick();
    assert.equal(feed.ready,false);assert.equal(received.length,0);assert.equal(feed.stats.anchorFailures,1);
  }finally{feed.close();}
});
test('disconnect requires a new anchor, and stale callbacks cannot release a new connection',async()=>{
  let resolveOld;const received=[];
  const feed=new SequencerFeed({WebSocketImpl:Socket,now:()=>1000000,reconnectBaseMs:10000,
    verify:()=>new Promise(r=>resolveOld=r),onHead:h=>received.push(h)}).start();
  await tick();const first=Socket.all.at(-1);
  try{
    first.message(frame(entry()));await tick();first.close();
    clearTimeout(feed.reconnectTimer);feed.reconnectTimer=null;feed.connect();await tick();
    resolveOld(true);await tick();assert.equal(feed.ready,false);assert.equal(received.length,0);
    const second=Socket.all.at(-1);
    feed.verify=async()=>true;second.message(frame(entry(101)));await tick();
    assert.equal(feed.ready,true);assert.equal(received.length,1);assert.equal(feed.stats.connections,2);
  }finally{feed.close();}
});
test('silent feed marks itself stalled and closes before retrying',async()=>{
  const feed=new SequencerFeed({WebSocketImpl:Socket,stallMs:20,reconnectBaseMs:10000}).start();
  await new Promise(r=>setTimeout(r,70));
  try{assert.equal(feed.state,'stalled');assert.equal(feed.ready,false);assert.equal(Socket.all.at(-1).closed,true);}
  finally{feed.close();}
});
test('feed anchor respects rate limit cooldown while another node can validate',async()=>{
  let now=0,calls=0;
  const verify=createFeedVerifier(['limited','good'],async url=>{
    if(url==='limited'){calls++;throw Object.assign(Error('rate'),{rateLimited:true,retryAfterMs:5000});}
    return head();
  },{mono:()=>now});
  assert.equal(await verify(head()),true);await verify(head());assert.equal(calls,1);
  now=5001;await verify(head());assert.equal(calls,2);
});
test('feed can win the shared gate without waiting for delayed HTTP reads',async()=>{
  let allowHttp=false;
  const watcher=new HeadWatcher({urls:['a'],useSequencerFeed:true,WebSocketImpl:Socket,now:()=>1000000,
    rpc:async(url,method,[tag])=>tag==='latest'&&!allowHttp?head(99,999):head()}).start();
  await tick();const ws=Socket.all.at(-1);
  try{
    ws.message(frame(entry()));await tick();
    const result=await watcher.waitForOpen(1000n,2000n,200);
    assert.equal(result.source,'feed');assert.equal(watcher.feed.stats.connections,1);
  }finally{allowHttp=true;watcher.close();}
});
test('HTTP fallback still fires when the official feed is unavailable',async()=>{
  class BrokenSocket{constructor(){throw Error('offline');}}
  const watcher=new HeadWatcher({urls:['a'],useSequencerFeed:true,WebSocketImpl:BrokenSocket,now:()=>1000000,rpc:async()=>head()}).start();
  try{assert.equal((await watcher.waitForOpen(1000n,2000n,200)).source,'http');}
  finally{watcher.close();}
});
test('latency summaries use real samples and compare matching hashes only',()=>{
  assert.deepEqual(summarize([]),{samples:0,minMs:null,p50Ms:null,p95Ms:null,maxMs:null});
  assert.equal(summarize([10,20,30,40]).p95Ms,40);
  const feed=new Map(),rpc=new Map();
  recordArrival(feed,head(),10);recordArrival(feed,head(),15);recordArrival(rpc,head(),30);
  recordArrival(feed,head(101),40);recordArrival(rpc,{...head(101),hash:otherHash},20);
  const result=compareArrivals(feed,rpc);
  assert.equal(result.rpcObservedAfterFeed.samples,1);assert.equal(result.rpcObservedAfterFeed.p50Ms,20);
  assert.equal(result.feedFirst,1);
  assert.equal(recommendSendTimeout([{warm:{p95Ms:972}}],1000).recommendedMs,1200);
  assert.equal(recommendSendTimeout([],1000).recommendedMs,null);
});
test('local timer overshoot does not conflate wall clock jumps with timer latency',async()=>{
  let mono=0,wall=0;
  const result=await measureLocalTimers({samples:3,intervalMs:20,mono:()=>mono,wall:()=>wall,
    pause:async ms=>{mono+=ms+5;wall+=ms+5+100;}});
  assert.equal(result.timerOvershoot.p50Ms,5);assert.equal(result.maxWallClockStepMs,300);
  assert.equal(result.absoluteClockOffsetMs,null);
});
