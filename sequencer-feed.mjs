import {validateRead} from './rpc-read.mjs';
export const OFFICIAL_FEED='wss://feed.mainnet.chain.robinhood.com';
const hash=/^0x[0-9a-f]{64}$/i;
export function decodeFeedFrame(text,{now=Date.now(),maxAgeMs=3000,maxFutureMs=2000}={}){
  if(typeof text!=='string'||Buffer.byteLength(text)>8*1024*1024)throw Error('Invalid feed frame size');
  const data=JSON.parse(text);
  if(data?.version!==1||!Array.isArray(data.messages??[]))throw Error('Unsupported feed envelope');
  const heads=[];
  let stale=0,invalid=0;
  for(const message of data.messages??[]){
    const timestamp=message?.message?.message?.header?.timestamp;
    const sequence=message?.sequenceNumber;
    if(!Number.isSafeInteger(sequence)||sequence<0||!Number.isSafeInteger(timestamp)||timestamp<=0||
      !hash.test(message.blockHash??'')){invalid++;continue;}
    const age=now-timestamp*1000;
    if(age>maxAgeMs||age< -maxFutureMs){stale++;continue;}
    // Header.blockNumber is L1. Only sequenceNumber maps to L2 on this chain;
    // this mapping MUST be anchored against a verified Robinhood RPC.
    heads.push({number:'0x'+sequence.toString(16),timestamp:'0x'+timestamp.toString(16),hash:message.blockHash.toLowerCase()});
  }
  return {heads,stale,invalid};
}
export function matchingFeedHead(feed,block){
  try{
    validateRead('eth_getBlockByNumber',[feed.number,false],block);
    return block.hash.toLowerCase()===feed.hash.toLowerCase()&&BigInt(block.timestamp)===BigInt(feed.timestamp);
  }catch{return false;}
}
export function createFeedVerifier(urls,rpc,{timeoutMs=1000,mono=()=>performance.now()}={}){
  const cooldown=new Map();
  return async head=>{
    try{return await Promise.any(urls.map(async url=>{
      if((cooldown.get(url)??0)>mono())throw Error('Feed anchor endpoint cooling down');
      try{
        const block=await rpc(url,'eth_getBlockByNumber',[head.number,false],timeoutMs);
        if(!matchingFeedHead(head,block))throw Error('Feed anchor mismatch');
        return true;
      }catch(e){if(e.rateLimited)cooldown.set(url,mono()+(e.retryAfterMs??1000));throw e;}
    }));}catch{return false;}
  };
}
// Trust boundary: fixed official TLS endpoint, plus an RPC anchor per connection.
// This is not signatureV2 verification; no custom/third-party feed URL is accepted.
export class SequencerFeed {
  constructor({verify,onHead=()=>{},onStatus=()=>{},WebSocketImpl=globalThis.WebSocket,
    now=Date.now,mono=()=>performance.now(),connectTimeoutMs=5000,stallMs=2000,
    reconnectBaseMs=1000,reconnectMaxMs=15000,maxAgeMs=3000}={}){
    Object.assign(this,{verify,onHead,onStatus,WebSocketImpl,now,mono,connectTimeoutMs,stallMs,reconnectBaseMs,reconnectMaxMs,maxAgeMs});
    this.closed=false;this.ready=false;this.failures=0;this.lastSequence=-1n;
    this.stats={connections:0,reconnects:0,frames:0,heads:0,stale:0,invalid:0,duplicates:0,anchorFailures:0,stalls:0};
  }
  start(){if(!this.started){this.started=true;this.connect();}return this;}
  status(state){this.state=state;this.onStatus({state,ready:this.ready});}
  connect(){
    if(this.closed)return;
    let ws;
    try{ws=new this.WebSocketImpl(OFFICIAL_FEED);}catch{this.schedule();return;}
    this.ws=ws;this.ready=false;this.pending=null;this.anchoring=false;this.nextAnchorAt=0;
    this.stats.connections++;this.status('connecting');
    const fail=(state)=>{
      if(this.ws!==ws)return;
      this.ws=null;this.ready=false;clearTimeout(this.handshake);clearTimeout(this.stallTimer);
      this.status(state);try{ws.close();}catch{}this.schedule();
    };
    this.handshake=setTimeout(()=>fail('connect_timeout'),this.connectTimeoutMs);
    ws.addEventListener('open',()=>{
      if(this.ws!==ws)return;
      clearTimeout(this.handshake);this.status('anchoring');
      this.lastMessageAt=this.mono();this.watchStall(ws,fail);
      // Nitro feed pushes without JSON-RPC eth_subscribe.
    });
    ws.addEventListener('message',event=>{
      if(this.ws!==ws)return;
      const receivedAt=this.now(),receivedMono=this.mono();
      let decoded;
      try{decoded=decodeFeedFrame(event.data,{now:receivedAt,maxAgeMs:this.maxAgeMs});}
      catch{this.stats.invalid++;fail('invalid_frame');return;}
      this.stats.frames++;this.stats.stale+=decoded.stale;this.stats.invalid+=decoded.invalid;
      // Ignore backlog. The newest valid head from this frame is all a trigger needs.
      const head=decoded.heads.reduce((a,b)=>!a||BigInt(b.number)>BigInt(a.number)?b:a,null);
      if(!head)return;
      this.lastMessageAt=receivedMono;
      if(BigInt(head.number)<=this.lastSequence){this.stats.duplicates++;return;}
      this.pending={head,receivedAt,receivedMono};
      if(this.ready)this.deliver(this.pending);
      else if(!this.anchoring&&this.mono()>=this.nextAnchorAt){
        this.anchoring=true;
        const candidate=this.pending;
        Promise.resolve().then(()=>this.verify?.(candidate.head)).then(ok=>{
          if(this.ws!==ws||this.closed)return;
          if(!ok){this.stats.anchorFailures++;this.nextAnchorAt=this.mono()+1000;return;}
          this.ready=true;this.failures=0;this.status('ready');
          // Anchor latency is paid before T0. Recheck freshness before releasing queued head.
          this.deliver(this.pending);
        }).catch(()=>{
          if(this.ws===ws){this.stats.anchorFailures++;this.nextAnchorAt=this.mono()+1000;}
        }).finally(()=>{if(this.ws===ws)this.anchoring=false;});
      }
    });
    ws.addEventListener('error',()=>fail('connection_error'));
    ws.addEventListener('close',()=>fail('disconnected'));
  }
  deliver(item){
    if(!item||this.closed||!this.ready)return;
    const {head,receivedAt,receivedMono}=item,sequence=BigInt(head.number);
    const age=this.now()-Number(BigInt(head.timestamp))*1000;
    if(age>this.maxAgeMs||age< -2000||this.mono()-receivedMono>this.stallMs)return;
    if(sequence<=this.lastSequence)return;
    if(this.lastTimestamp!=null&&BigInt(head.timestamp)<this.lastTimestamp){this.stats.invalid++;return;}
    this.lastTimestamp=BigInt(head.timestamp);this.lastSequence=sequence;this.stats.heads++;
    this.onHead(head,{source:'feed',receivedAt,receivedMono,deliveredMono:this.mono()});
  }
  watchStall(ws,fail){
    this.stallTimer=setTimeout(()=>{
      if(this.ws!==ws||this.closed)return;
      if(this.mono()-this.lastMessageAt>=this.stallMs){this.stats.stalls++;fail('stalled');}
      else this.watchStall(ws,fail);
    },Math.min(500,this.stallMs));
  }
  schedule(){
    if(this.closed||this.reconnectTimer)return;
    const delay=Math.min(this.reconnectMaxMs,this.reconnectBaseMs*2**Math.min(this.failures++,8));
    this.stats.reconnects++;
    this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.connect();},delay);
  }
  close(){
    this.closed=true;this.ready=false;
    clearTimeout(this.handshake);clearTimeout(this.stallTimer);clearTimeout(this.reconnectTimer);
    const ws=this.ws;this.ws=null;try{ws?.close();}catch{}
  }
}
