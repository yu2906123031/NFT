import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {platform,arch} from 'node:os';
import {RpcPool} from './rpc-pool.mjs';
import {SequencerFeed,createFeedVerifier} from './sequencer-feed.mjs';
import {validateRead} from './rpc-read.mjs';
import {CHAIN,sleep} from './core.mjs';
import {acquireRunLock} from './run-lock.mjs';
import {summarize,measureLocalTimers,recordArrival,compareArrivals,recommendSendTimeout} from './latency.mjs';
const root=new URL('./',import.meta.url);
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^﻿/,''));
export async function runLocalBenchmark({single=false,seconds=15,samples=8,print=console.log}={}){
  if(!Number.isInteger(seconds)||seconds<5||seconds>60||!Number.isInteger(samples)||samples<3||samples>30)
    throw Error('Benchmark seconds must be 5-60 and samples 3-30');
  const base=await json(process.env.MINT_CONFIG||new URL('config.json',root));
  const cfg=single?base:{...base,...await json(process.env.MULTI_CONFIG||new URL('multi-config.json',root))};
  const broadcastUrls=[...new Set(cfg.broadcastRpcs)],readUrls=[...new Set(cfg.readRpcs??[cfg.readRpc])];
  if(!broadcastUrls.length||broadcastUrls.length>8||!readUrls.length||readUrls.length>3)throw Error('Invalid benchmark endpoint count');
  for(const url of [...broadcastUrls,...readUrls])if(new URL(url).protocol!=='https:')throw Error('HTTPS endpoints required');
  const release=await acquireRunLock(new URL('multi-run.lock',root));
  const reads=new RpcPool({timeoutMs:3000,sockets:3}),writes=new RpcPool({timeoutMs:3000,sockets:1});
  const report={startedAt:new Date().toISOString(),environment:{platform:platform(),arch:arch(),node:process.version},
    readOnly:true,privateKeysLoaded:false,transactionsBroadcast:0,notes:[
      '无效交易拒包 RTT 不等于真实交易入块延迟。',
      '同块到达差使用本机单调时钟，包含 HTTP 500ms 轮询间隔；不能算作 feed 的纯传输优势。',
      '本机与链上秒级时间戳的差值不是单程网络延迟，也不是 NTP 校时结果。',
      '只打印超时建议，不自动修改发送偏移、费用、端点或系统时间。'
    ]};
  let feed;
  try{
    print('本机只读测速：不加载私钥、不签名、不广播有效交易。');
    print('先测连接和本机调度，再对比官方 feed 与 HTTP 同块到达时间。');
    const localTask=measureLocalTimers();
    const endpointTask=Promise.all(broadcastUrls.map(async(url,index)=>{
      const observations=[],warm=[],failures=[],stages=[],reused=[];
      let cold=null;
      for(let i=0;i<samples+1;i++){
        let timing;
        try{
          const ms=await writes.probe(url,3000,t=>timing=t);
          if(i===0)cold={rttMs:ms,...timing};else{warm.push(ms);if(timing?.reusedSocket)reused.push(ms);}
          observations.push({sample:i,rttMs:ms,reusedSocket:!!timing?.reusedSocket});
        }catch(e){
          failures.push({sample:i,rateLimited:!!e.rateLimited,httpStatus:e.httpStatus??null,retryAfterMs:e.retryAfterMs??null});
          if(e.rateLimited||failures.length>=3)break; // Stop rather than hammer a throttled endpoint.
        }
        if(timing)stages.push(timing);
        if(i<samples)await sleep(500);
      }
      return {endpoint:index,host:new URL(url).hostname,cold,warm:summarize(warm),reused:summarize(reused),
        firstByte:summarize(stages.slice(1).map(t=>t.firstByteMs)),
        localRequestWrite:summarize(stages.slice(1).map(t=>t.requestWrittenMs)),
        failures,observations};
    }));
    const checked=await Promise.all(readUrls.map(async(url,index)=>{
      const t=performance.now();
      try{
        if(BigInt(await reads.call(url,'eth_chainId'))!==CHAIN)throw Error('Wrong chain');
        return {url,index,verified:true,chainCheckMs:performance.now()-t};
      }catch(e){return {url,index,verified:false,rateLimited:!!e.rateLimited};}
    }));
    report.readNodes=checked.map(({url,...r})=>({...r,host:new URL(url).hostname}));
    const active=checked.filter(r=>r.verified),feedArrivals=new Map(),rpcArrivals=new Map(active.map(r=>[r.index,new Map()]));
    const timestampDelta=[],intervals=[],readSamples=new Map(active.map(r=>[r.index,{rtt:[],failures:0,rateLimits:0}]));
    let lastFeedAt=null;
    if(active.length){
      feed=new SequencerFeed({
        verify:createFeedVerifier(active.map(r=>r.url),reads.call.bind(reads)),
        onHead:(head,meta)=>{
          recordArrival(feedArrivals,head,meta.receivedMono);
          timestampDelta.push(meta.receivedAt-Number(BigInt(head.timestamp))*1000);
          if(lastFeedAt!==null)intervals.push(meta.receivedMono-lastFeedAt);
          lastFeedAt=meta.receivedMono;
        }
      }).start();
      const end=performance.now()+seconds*1000;
      await Promise.all(active.map(async({url,index})=>{
        const stats=readSamples.get(index),arrivals=rpcArrivals.get(index);
        while(performance.now()<end){
          const t=performance.now();let pause=500;
          try{
            const block=validateRead('eth_getBlockByNumber',['latest',false],await reads.call(url,'eth_getBlockByNumber',['latest',false],1500));
            stats.rtt.push(performance.now()-t);recordArrival(arrivals,block,performance.now());
          }catch(e){
            stats.failures++;
            if(e.rateLimited){stats.rateLimits++;pause=Math.max(pause,e.retryAfterMs??1000);}
          }
          await sleep(Math.min(pause,Math.max(0,end-performance.now())));
        }
      }));
      report.feed={state:feed.state,ready:feed.ready,...feed.stats,arrivalIntervals:summarize(intervals),
        localMinusBlockTimestamp:summarize(timestampDelta),signatureVerification:false,
        trust:'Official WSS TLS endpoint, RPC block hash/timestamp anchor per connection'};
      feed.close();
      report.blockArrivalComparison=active.map(({url,index})=>({endpoint:index,host:new URL(url).hostname,pollIntervalMs:500,
        readRtt:summarize(readSamples.get(index).rtt),readFailures:readSamples.get(index).failures,
        rateLimits:readSamples.get(index).rateLimits,...compareArrivals(feedArrivals,rpcArrivals.get(index))}));
    }else{
      report.feed={state:'NO_VERIFIED_READ_RPC',ready:false};
      report.blockArrivalComparison=[];
    }
    report.local=await localTask;
    report.broadcast=await endpointTask;
    report.sendTimeout=recommendSendTimeout(report.broadcast,cfg.sendTimeoutMs??1000);
    report.finishedAt=new Date().toISOString();
    report.status=active.length&&report.broadcast.some(r=>r.warm.samples>0)?'MEASURED':'INCOMPLETE';
    const ms=v=>v==null?'不可用':v.toFixed(2)+' ms';
    const lines=[
      '本机测速结果 '+report.finishedAt,
      '定时器额外延迟 P50 / P95 / 最大：'+[report.local.timerOvershoot.p50Ms,report.local.timerOvershoot.p95Ms,report.local.timerOvershoot.maxMs].map(ms).join(' / '),
      '测试期间本机时钟跳变观测：'+ms(report.local.maxWallClockStepMs)+'（不是绝对校时精度）'
    ];
    for(const r of report.broadcast)lines.push(r.host+'：冷连接 '+ms(r.cold?.rttMs)+'；热请求 P50 / P95 '+ms(r.warm.p50Ms)+' / '+ms(r.warm.p95Ms)+'；复用连接样本 '+r.reused.samples+'；失败 '+r.failures.length);
    for(const r of report.broadcast)lines.push(r.host+'：本机写出 P95 '+ms(r.localRequestWrite.p95Ms)+'；响应头 RTT P95 '+ms(r.firstByte.p95Ms));
    lines.push('官方 feed：'+report.feed.state+'，已接收有效块 '+(report.feed.heads??0)+'，重连 '+(report.feed.reconnects??0));
    for(const r of report.blockArrivalComparison)lines.push(r.host+'：匹配 '+r.rpcObservedAfterFeed.samples+' 个同块；RPC 比 feed 晚 P50 / P95 '+ms(r.rpcObservedAfterFeed.p50Ms)+' / '+ms(r.rpcObservedAfterFeed.p95Ms)+'（含轮询间隔）');
    lines.push('发送超时建议：'+ms(report.sendTimeout.recommendedMs)+'；当前 '+ms(report.sendTimeout.currentMs)+'，配置未修改。',...report.notes);
    await mkdir(new URL('reports/',root),{recursive:true});
    const name='reports/local-bench-'+report.startedAt.replace(/[:.]/g,'-');
    await writeFile(new URL(name+'.json',root),JSON.stringify(report,null,2)+'\n');
    await writeFile(new URL(name+'.txt',root),lines.join('\n')+'\n');
    lines.forEach(line=>print(line));print('报告：'+name+'.json / .txt');
    if(report.status==='INCOMPLETE')process.exitCode=2;
    return report;
  }finally{feed?.close();reads.close();writes.close();await release();}
}
