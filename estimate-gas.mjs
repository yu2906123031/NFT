import {readFile} from 'node:fs/promises';
import {toQuantity} from 'ethers';
import {CHAIN,NFT,SEA,abi,mintData,sleep} from './core.mjs';
import {RpcPool} from './rpc-pool.mjs';
const cfg=JSON.parse((await readFile(process.env.MINT_CONFIG||new URL('./config.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
const pool=new RpcPool({timeoutMs:cfg.rpcTimeoutMs});
try{
  const rpc=(method,params=[])=>pool.call(cfg.readRpc,method,params);
  if(BigInt(await rpc('eth_chainId'))!==CHAIN)throw Error('Wrong chain');
  const samples=[];
  for(let i=0;i<3;i++){
    const block=await rpc('eth_getBlockByNumber',['latest',false]);
    const call=async(name)=>abi.decodeFunctionResult(name,await rpc('eth_call',[{to:SEA,data:abi.encodeFunctionData(name,[NFT])},block.number]))[0];
    const [fees,drop]=await Promise.all([call('getAllowedFeeRecipients'),call('getPublicDrop')]);
    if(drop.mintPrice!==0n||BigInt(block.timestamp)>drop.endTime)throw Error('Not an eligible free sale');
    if(!fees.length)throw Error('No verified fee recipient');
    const tx={from:cfg.walletAddress,to:SEA,data:mintData(fees[0]),value:'0x0'};
    const time=toQuantity(BigInt(block.timestamp)>drop.startTime?BigInt(block.timestamp):drop.startTime+1n);
    const params=[tx,block.number,{}, {time}];
    if(await rpc('eth_call',params)!=='0x')throw Error('Unexpected simulation return');
    const estimate=BigInt(await rpc('eth_estimateGas',params));
    if(estimate<=0n)throw Error('Invalid gas estimate');
    samples.push(estimate);
    console.log({sample:i+1,estimate:String(estimate),simulationTimestamp:String(BigInt(time))});
    if(i<2)await sleep(300);
  }
  const maximum=samples.reduce((a,b)=>a>b?a:b);
  console.log({samples:samples.map(String),proposedGasLimit:String((maximum*125n+99n)/100n),marginPercent:25,configuredGasLimit:cfg.gasLimit});
}catch(e){console.error('Simulation failed: '+e.message);process.exitCode=1;}
finally{pool.close();}
