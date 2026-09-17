import {readFile} from 'node:fs/promises';
import {ZeroAddress} from 'ethers';
import {RpcPool} from './rpc-pool.mjs';
import {createReadFallback} from './rpc-read.mjs';
import {CHAIN,NFT,SEA,abi,validateState} from './core.mjs';
export async function saleStatus(cfg){
  const pool=new RpcPool({timeoutMs:cfg.rpcTimeoutMs});
  try{
    const urls=cfg.readRpcs??[cfg.readRpc];
    const verified=await Promise.allSettled(urls.map(async url=>{
      if(BigInt(await pool.call(url,'eth_chainId'))!==CHAIN)throw Error('Wrong chain');
      return url;
    }));
    const active=verified.filter(r=>r.status==='fulfilled').map(r=>r.value);
    if(!active.length)throw Error('No verified read endpoint');
    const read=createReadFallback(active,pool.call.bind(pool));
    const block=await read('eth_getBlockByNumber',['latest',false]);
    const call=async(to,name,args)=>abi.decodeFunctionResult(name,await read('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block.number]));
    const [allowed,drop,fees,stats]=await Promise.all([
      call(NFT,'getAllowedSeaDrop',[]),call(SEA,'getPublicDrop',[NFT]),
      call(SEA,'getAllowedFeeRecipients',[NFT]),call(NFT,'getMintStats',[cfg.walletAddress||ZeroAddress])]);
    const s={chain:CHAIN,now:BigInt(block.timestamp),allowed:allowed[0],drop:drop[0],fees:fees[0],
      userMinted:stats[0],minted:stats[1],maximum:stats[2]};
    let reason=null;try{validateState(s,cfg);}catch(e){reason=e.message;}
    return {chainId:String(CHAIN),blockNumber:String(BigInt(block.number)),
      startUTC:new Date(Number(s.drop.startTime)*1000).toISOString(),
      startBeijing:new Date(Number(s.drop.startTime)*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),
      endUTC:new Date(Number(s.drop.endTime)*1000).toISOString(),
      chainTimeUTC:new Date(Number(s.now)*1000).toISOString(),
      mintPriceWei:String(s.drop.mintPrice),minted:String(s.minted),maximum:String(s.maximum),
      remaining:String(s.maximum-s.minted),walletMinted:String(s.userMinted),
      saleStatus:s.now<s.drop.startTime?'NOT_STARTED':s.now>s.drop.endTime?'ENDED':'OPEN',
      eligible:!reason,reason};
  }finally{pool.close();}
}
export async function checkSale(){
  const cfg=JSON.parse((await readFile(process.env.MINT_CONFIG||new URL('./config.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
  const result=await saleStatus(cfg);console.log(JSON.stringify(result,null,2));
  if(!result.eligible)process.exitCode=2;
}
