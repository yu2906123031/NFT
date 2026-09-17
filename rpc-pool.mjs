import https from 'node:https';
export class RpcPool {
  constructor({timeoutMs=3000,sockets=8,allowBroadcast=false}={}){
    this.timeoutMs=timeoutMs;this.allowBroadcast=allowBroadcast;this.id=0;
    this.agent=new https.Agent({keepAlive:true,keepAliveMsecs:1000,maxSockets:sockets,maxFreeSockets:sockets,scheduling:'lifo',timeout:60000});
  }
  async call(url,method,params=[],timeoutMs=this.timeoutMs){
    return this.prepareCall(url,method,params,timeoutMs)();
  }
  prepareCall(url,method,params=[],timeoutMs=this.timeoutMs){
    if(method==='eth_sendRawTransaction'&&params[0]!=='0x'&&!this.allowBroadcast)throw Error('Real broadcast disabled');
    if(!['eth_chainId','eth_getBlockByNumber','eth_call','eth_getBalance','eth_getTransactionCount','eth_gasPrice','eth_estimateGas','eth_getTransactionReceipt','eth_sendRawTransaction'].includes(method))throw Error('Unsupported RPC method');
    const id=++this.id;
    const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,params}));
    return ()=>new Promise((resolve,reject)=>{
      const req=https.request(url,{method:'POST',agent:this.agent,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},signal:AbortSignal.timeout(timeoutMs)},res=>{
        let content='',size=0;
        res.setEncoding('utf8');
        res.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>2000000)req.destroy(Error('Oversized response'));else content+=chunk;});
        res.on('error',()=>reject(Error('RPC response interrupted')));
        res.on('end',()=>{
          if(res.statusCode!==200)return reject(Error('RPC HTTP '+res.statusCode));
          let data;try{data=JSON.parse(content);}catch{return reject(Error('Malformed RPC JSON'));}
          if(!data||typeof data!=='object'||Array.isArray(data))return reject(Error('Invalid RPC response'));
          if(data.jsonrpc!=='2.0'||data.id!==id)return reject(Error('RPC response version or ID mismatch'));
          if(Object.hasOwn(data,'error')&&Object.hasOwn(data,'result'))return reject(Error('Ambiguous RPC response'));
          if(data.error){
            const e=Error('RPC error code '+Number(data.error.code));e.code=Number(data.error.code);
            // Keep only a controlled classification, never arbitrary server text.
            const message=String(data.error.message??'').toLowerCase();
            e.broadcastStatus=/already known|known transaction/.test(message)?'already_known':
              /nonce too low|nonce has already been used/.test(message)?'nonce_too_low':'rpc_error';
            if(typeof data.error.data==='string'&&/^0x[0-9a-f]*$/i.test(data.error.data))e.data=data.error.data;
            return reject(e);
          }
          if(!Object.hasOwn(data,'result'))return reject(Error('Missing RPC result'));
          resolve(data.result);
        });
      });
      req.on('socket',s=>s.setNoDelay(true));
      req.on('error',()=>reject(Error('RPC connection failed or timed out')));
      req.end(body);
    });
  }
  async probe(url,timeoutMs=this.timeoutMs){
    const t=performance.now();
    try{await this.call(url,'eth_sendRawTransaction',['0x'],timeoutMs);}
    catch(e){if(e.code===-32000||e.code===-32602||e.code===-32600)return Math.round(performance.now()-t);throw Error('Broadcast probe unavailable');}
    throw Error('Unexpected probe response');
  }
  close(){this.agent.destroy();}
}
