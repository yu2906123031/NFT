import https from 'node:https';
export function retryAfterMs(value,now=Date.now()){
  const seconds=Number(value);
  const delay=value!=null&&String(value).trim()!==''&&Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now;
  return Number.isFinite(delay)?Math.max(1000,Math.min(86400000,Math.ceil(delay))):1000;
}
export class RpcPool {
  constructor({timeoutMs=3000,sockets=8,allowBroadcast=false}={}){
    this.timeoutMs=timeoutMs;this.allowBroadcast=allowBroadcast;this.id=0;this.cooldowns=new Map();
    this.agent=new https.Agent({keepAlive:true,keepAliveMsecs:1000,maxSockets:sockets,maxFreeSockets:sockets,scheduling:'lifo',timeout:60000});
  }
  async call(url,method,params=[],timeoutMs=this.timeoutMs,onTiming){
    return this.prepareCall(url,method,params,timeoutMs,onTiming)();
  }
  prepareCall(url,method,params=[],timeoutMs=this.timeoutMs,onTiming){
    if(method==='eth_sendRawTransaction'&&params[0]!=='0x'&&!this.allowBroadcast)throw Error('Real broadcast disabled');
    if(!['eth_chainId','eth_getBlockByNumber','eth_call','eth_getBalance','eth_getTransactionCount','eth_gasPrice','eth_estimateGas','eth_getTransactionReceipt','eth_sendRawTransaction'].includes(method))throw Error('Unsupported RPC method');
    const origin=new URL(url).origin;
    const id=++this.id,body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,params}));
    return ()=>new Promise((resolve,reject)=>{
      const t=onTiming?performance.now():0;
      const timing=onTiming?{dnsMs:null,tcpMs:null,tlsMs:null,requestWrittenMs:null,firstByteMs:null,reusedSocket:false,httpStatus:null}:null;
      let settled=false,req;
      const finish=(error,result)=>{
        if(settled)return;settled=true;
        if(error?.rateLimited&&!error.fromCooldown)this.cooldowns.set(origin,performance.now()+(error.retryAfterMs??1000));
        if(timing){
          const metric={...timing,totalMs:performance.now()-t,outcome:error?'error':'ok',
            rpcCode:error?.code??null,rateLimited:!!error?.rateLimited,retryAfterMs:error?.retryAfterMs??null};
          try{onTiming(metric);}catch{} // Diagnostics must never alter transaction handling.
        }
        if(error)reject(error);else resolve(result);
      };
      const remaining=(this.cooldowns.get(origin)??0)-performance.now();
      if(remaining>0){
        finish(Object.assign(Error('RPC endpoint cooling down after rate limit'),
          {rateLimited:true,retryAfterMs:Math.ceil(remaining),fromCooldown:true}));return;
      }
      try{
        req=https.request(url,{method:'POST',agent:this.agent,headers:{'content-type':'application/json','content-length':body.length},signal:AbortSignal.timeout(timeoutMs)},res=>{
          if(timing){timing.firstByteMs=performance.now()-t;timing.httpStatus=res.statusCode;timing.reusedSocket=!!req.reusedSocket;}
          let content='',size=0;
          res.setEncoding('utf8');
          res.on('data',chunk=>{
            size+=Buffer.byteLength(chunk);
            if(size>2000000){req.destroy(Error('Oversized response'));finish(Error('Oversized response'));}
            else content+=chunk;
          });
          res.on('error',()=>finish(Error('RPC response interrupted')));
          res.on('end',()=>{
            if(res.statusCode!==200){
              const error=Object.assign(Error('RPC HTTP '+res.statusCode),{httpStatus:res.statusCode,rateLimited:res.statusCode===429});
              if(error.rateLimited)error.retryAfterMs=retryAfterMs(res.headers?.['retry-after']);
              return finish(error);
            }
            let data;try{data=JSON.parse(content);}catch{return finish(Error('Malformed RPC JSON'));}
            if(!data||typeof data!=='object'||Array.isArray(data))return finish(Error('Invalid RPC response'));
            if(data.jsonrpc!=='2.0'||data.id!==id)return finish(Error('RPC response version or ID mismatch'));
            if(Object.hasOwn(data,'error')&&Object.hasOwn(data,'result'))return finish(Error('Ambiguous RPC response'));
            if(data.error){
              const message=String(data.error.message??'').toLowerCase();
              const e=Error('RPC error code '+Number(data.error.code));e.code=Number(data.error.code);
              e.rateLimited=e.code===-32005||/rate.?limit|too many requests/.test(message);
              if(e.rateLimited)e.retryAfterMs=retryAfterMs(res.headers?.['retry-after']);
              e.broadcastStatus=e.rateLimited?'rate_limited':/already known|known transaction/.test(message)?'already_known':
                /nonce too low|nonce has already been used/.test(message)?'nonce_too_low':'rpc_error';
              if(typeof data.error.data==='string'&&/^0x[0-9a-f]*$/i.test(data.error.data))e.data=data.error.data;
              return finish(e);
            }
            if(!Object.hasOwn(data,'result'))return finish(Error('Missing RPC result'));
            finish(null,data.result);
          });
        });
        req.on('socket',socket=>{
          socket.setNoDelay(true);
          if(!timing)return;
          timing.reusedSocket=!!req.reusedSocket;
          if(!socket.connecting)return;
          const at=performance.now();let lookup=at,connect=at;
          socket.once('lookup',()=>{lookup=performance.now();timing.dnsMs=lookup-at;});
          socket.once('connect',()=>{connect=performance.now();timing.tcpMs=connect-lookup;});
          socket.once('secureConnect',()=>{timing.tlsMs=performance.now()-connect;});
        });
        if(timing)req.on('finish',()=>{timing.requestWrittenMs=performance.now()-t;});
        req.on('error',()=>finish(Error('RPC connection failed or timed out')));
        req.end(body);
      }catch{finish(Error('RPC request setup failed'));}
    });
  }
  async probe(url,timeoutMs=this.timeoutMs,onTiming){
    const t=performance.now();
    try{await this.call(url,'eth_sendRawTransaction',['0x'],timeoutMs,onTiming);}
    catch(e){
      if(!e.rateLimited&&[-32000,-32602,-32600].includes(e.code))return Math.round(performance.now()-t);
      throw Object.assign(Error('Broadcast probe unavailable'),{rateLimited:!!e.rateLimited,retryAfterMs:e.retryAfterMs,httpStatus:e.httpStatus});
    }
    throw Error('Unexpected probe response');
  }
  close(){this.agent.destroy();}
}
