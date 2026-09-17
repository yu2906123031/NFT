const hex=/^0x[0-9a-f]+$/i;
const hash=/^0x[0-9a-f]{64}$/i;
const address=/^0x[0-9a-f]{40}$/i;
export function validateRead(method,params,result,now=Date.now()){
  if(method==='eth_getBlockByNumber'){
    if(!result||!hex.test(result.number)||!hex.test(result.timestamp)||!hash.test(result.hash))throw Error('Invalid block response');
    if(params[0]==='latest'){
      const age=now-Number(BigInt(result.timestamp))*1000;
      if(age>15000||age< -5000)throw Error('Stale block or clock mismatch');
    }else if(hex.test(params[0])&&BigInt(result.number)!==BigInt(params[0]))throw Error('Wrong block number');
  }else if(method==='eth_getTransactionReceipt'){
    if(result===null)return null;
    if(!result||!hash.test(result.transactionHash)||result.transactionHash.toLowerCase()!==params[0].toLowerCase()||!hash.test(result.blockHash)||!hex.test(result.blockNumber)||!address.test(result.from)||!address.test(result.to)||!['0x0','0x1'].includes(result.status)||!Array.isArray(result.logs))throw Error('Invalid or mismatched receipt');
    for(const log of result.logs)if(!address.test(log.address)||!Array.isArray(log.topics)||!log.topics.every(t=>hash.test(t))||!/^0x(?:[0-9a-f]{2})*$/i.test(log.data))throw Error('Malformed receipt log');
  }else if(method==='eth_call'){
    if(typeof result!=='string'||!/^0x(?:[0-9a-f]{2})*$/i.test(result))throw Error('Invalid contract result');
  }else if(['eth_chainId','eth_getTransactionCount','eth_getBalance','eth_gasPrice','eth_estimateGas'].includes(method)){
    if(typeof result!=='string'||!hex.test(result))throw Error('Invalid RPC quantity');
  }
  return result;
}
export function createReadFallback(urls,call,{now=Date.now}={}){
  return async(method,params=[])=>{
    if(method==='eth_getTransactionReceipt'){
      // A lagging primary's null must not hide a receipt held by a backup.
      try{return await Promise.any(urls.map(async url=>{
        const result=validateRead(method,params,await call(url,method,params),now());
        if(result===null)throw Error('Receipt not observed');
        return result;
      }));}catch{return null;}
    }
    for(const url of urls){
      try{return validateRead(method,params,await call(url,method,params),now());}catch{}
    }
    throw Error('All read endpoints failed for '+method);
  };
}