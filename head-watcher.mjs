import {SequencerFeed,createFeedVerifier} from './sequencer-feed.mjs';
import {CHAIN} from './core.mjs';
import {validateRead} from './rpc-read.mjs';
// One subscription and one fallback loop, shared by every wallet.
export class HeadWatcher {
  constructor({urls,rpc,wsUrl='',pollMs=100,timeoutMs=1000,WebSocketImpl=globalThis.WebSocket,now=Date.now,useSequencerFeed=false,feedStallMs=2000,backupPollMs=1000,onHead=()=>{}}){
    Object.assign(this,{urls,rpc,wsUrl,pollMs,timeoutMs,WebSocketImpl,now,useSequencerFeed,feedStallMs,backupPollMs,onHead});
    this.listeners=new Set();this.closed=false;this.sequence=0;
    if(wsUrl&&new URL(wsUrl).protocol!=='wss:')throw Error('WSS endpoint required');
  }
  start(){
    if(this.wsUrl)this.connect();
    if(this.useSequencerFeed){
      this.feed=new SequencerFeed({
        WebSocketImpl:this.WebSocketImpl,now:this.now,stallMs:this.feedStallMs,
        verify:createFeedVerifier(this.urls,this.rpc,{timeoutMs:this.timeoutMs}),
        onHead:(head,meta)=>this.accept(head,'feed',meta),
        onStatus:status=>{
          if(!status.ready){this.lastFeedHead=0;this.kickPoll?.();}
        }
      }).start();
    }
    return this;
  }
  accept(block,source,meta={receivedAt:this.now(),receivedMono:performance.now()}){
    try{validateRead('eth_getBlockByNumber',['latest',false],block,this.now());}catch{return false;}
    if(this.latest&&BigInt(block.number)<BigInt(this.latest.number))return false;
    this.latest=block;this.source=source;this.latestMeta=meta;
    if(source==='wss')this.lastWsHead=this.now();
    if(source==='feed')this.lastFeedHead=this.now();
    this.onHead(block,source,meta);
    for(const listener of this.listeners)listener(block,source,meta);
    return true;
  }
  connect(){
    if(this.closed)return;
    let ws;
    try{ws=new this.WebSocketImpl(this.wsUrl);}catch{this.reconnect();return;}
    this.ws=ws;
    const chainId=++this.sequence,subscribeId=++this.sequence;
    let subscription,verified=false;
    const fail=()=>{
      if(this.ws!==ws)return;
      this.ws=null;this.lastWsHead=0;this.kickPoll?.();clearTimeout(this.handshake);
      try{ws.close();}catch{}
      this.reconnect();
    };
    this.handshake=setTimeout(fail,this.timeoutMs);
    ws.addEventListener('open',()=>{if(this.ws===ws)ws.send(JSON.stringify({jsonrpc:'2.0',id:chainId,method:'eth_chainId',params:[]}));});
    ws.addEventListener('message',event=>{
      if(this.ws!==ws)return;
      try{
        if(typeof event.data!=='string'||event.data.length>2000000)throw Error('Invalid websocket data');
        const data=JSON.parse(event.data);
        if(data.jsonrpc!=='2.0'||data.error)throw Error('Invalid websocket response');
        if(data.id===chainId){
          if(BigInt(data.result)!==CHAIN)throw Error('Wrong websocket chain');
          verified=true;
          ws.send(JSON.stringify({jsonrpc:'2.0',id:subscribeId,method:'eth_subscribe',params:['newHeads']}));
        }else if(data.id===subscribeId){
          if(!verified||typeof data.result!=='string'||!data.result)throw Error('Invalid subscription');
          subscription=data.result;clearTimeout(this.handshake);
        }else if(subscription&&data.method==='eth_subscription'&&data.params?.subscription===subscription){
          this.accept(data.params.result,'wss');
        }
      }catch{fail();}
    });
    ws.addEventListener('error',fail);
    ws.addEventListener('close',fail);
  }
  reconnect(){
    if(this.closed||this.reconnectTimer)return;
    this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.connect();},1000);
  }
  waitForOpen(startTime,endTime,timeoutMs){
    if(this.waiting)return this.waiting;
    this.waiting=new Promise((resolve,reject)=>{
      let done=false,pollTimer,deadlineTimer;
      const finish=(error,value)=>{
        if(done)return;done=true;clearTimeout(pollTimer);clearTimeout(deadlineTimer);
        this.listeners.delete(check);this.cancelWait=null;this.kickPoll=null;
        if(error)reject(error);else resolve(value);
      };
      const check=(block,source,meta)=>{
        try{
          validateRead('eth_getBlockByNumber',['latest',false],block,this.now());
          const time=BigInt(block.timestamp);
          if(time>BigInt(endTime))return finish(Error('Sale ended before trigger'));
          if(time>=BigInt(startTime))finish(null,{block,source,...meta});
        }catch{}
      };
      this.cancelWait=()=>finish(Error('Head watcher closed'));
      this.listeners.add(check);
      deadlineTimer=setTimeout(()=>finish(Error('No opening block within configured deadline')),timeoutMs);
      if(this.latest)check(this.latest,this.source,this.latestMeta);
      const inFlight=new Set(),cooldown=new Map();
      const poll=()=>{
        if(done)return;
        clearTimeout(pollTimer);
        for(const url of this.urls){
          if(inFlight.has(url)||(cooldown.get(url)??0)>performance.now())continue;
          inFlight.add(url);
          void this.rpc(url,'eth_getBlockByNumber',['latest',false],this.timeoutMs)
            .then(block=>{if(!done)this.accept(block,'http');})
            .catch(e=>{if(e.rateLimited)cooldown.set(url,performance.now()+(e.retryAfterMs??1000));}).finally(()=>inFlight.delete(url));
        }
        if(!done)pollTimer=setTimeout(poll,Math.max(this.lastWsHead??0,this.lastFeedHead??0)>this.now()-1000?this.backupPollMs:this.pollMs);
      };
      this.kickPoll=poll;
      if(!done)void poll();
    });
    return this.waiting;
  }
  close(){
    this.closed=true;this.feed?.close();clearTimeout(this.handshake);clearTimeout(this.reconnectTimer);
    this.cancelWait?.();this.listeners.clear();
    const ws=this.ws;this.ws=null;try{ws?.close();}catch{}
  }
}
