import {readFile} from 'node:fs/promises';
import {loadLocalEnv} from './env.mjs';
import {Wallet,Transaction,formatEther,parseUnits,Interface} from 'ethers';
import {CHAIN,NFT,SEA,abi,same,mintData,validateState,validateCost} from './core.mjs';
try {
await loadLocalEnv();
const env=process.env;
let wallet;
try{wallet=new Wallet(env.MINT_PRIVATE_KEY||env.PRIVATE_KEY||process.env.MINT_PRIVATE_KEY||'');}catch{throw Error('Invalid private key format');}
const cfg=JSON.parse((await readFile(new URL('./config.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
if(!Number.isInteger(cfg.gasPriceMultiplier??2)||(cfg.gasPriceMultiplier??2)<1||(cfg.gasPriceMultiplier??2)>10)throw Error('Invalid gasPriceMultiplier');
const expected=cfg.walletAddress||env.WALLET_ADDRESS;
if(!expected||!same(expected,wallet.address))throw Error('Configured address missing or mismatched');
console.log('Address matches private key: '+wallet.address);
async function rpc(method,params=[]){
if(!['eth_chainId','eth_getBlockByNumber','eth_call','eth_getBalance','eth_getTransactionCount','eth_gasPrice','eth_estimateGas'].includes(method))throw Error('Read-only guard');
const r=await fetch(cfg.readRpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
if(!r.ok)throw Error('RPC HTTP '+r.status);
const d=await r.json();
if(d.error){const e=Error('RPC error '+Number(d.error.code));e.data=typeof d.error.data==='string'?d.error.data:null;throw e;}return d.result;
}
const block=await rpc('eth_getBlockByNumber',['latest',false]);
const call=async(to,name,args=[])=>abi.decodeFunctionResult(name,await rpc('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block.number]));
const [chain,allowed,drop,fees,stats,balance,latest,pending,price]=await Promise.all([
rpc('eth_chainId'),call(NFT,'getAllowedSeaDrop'),call(SEA,'getPublicDrop',[NFT]),call(SEA,'getAllowedFeeRecipients',[NFT]),call(NFT,'getMintStats',[wallet.address]),
rpc('eth_getBalance',[wallet.address,'latest']),rpc('eth_getTransactionCount',[wallet.address,'latest']),rpc('eth_getTransactionCount',[wallet.address,'pending']),rpc('eth_gasPrice')]);
const s={chain:BigInt(chain),allowed:allowed[0],drop:drop[0],fees:fees[0],userMinted:stats[0],minted:stats[1],maximum:stats[2],now:BigInt(block.timestamp)};
validateState(s,cfg);
if(BigInt(latest)!==BigInt(pending))throw Error('Pending transactions exist');
console.log(JSON.stringify({balanceEth:formatEther(balance),nonce:Number(BigInt(pending)),remaining:String(s.maximum-s.minted),walletMinted:String(s.userMinted),startUTC:new Date(Number(s.drop.startTime)*1000).toISOString(),chainTimeUTC:new Date(Number(s.now)*1000).toISOString(),trigger:cfg.trigger,gasLimit:cfg.gasLimit,maxGasBudgetEth:cfg.maxGasBudgetEth},null,2));
const data=mintData(s.fees[0]),tx={from:wallet.address,to:SEA,data,value:'0x0'};
const errors=new Interface(['error NotActive(uint256 currentTimestamp,uint256 startTimestamp,uint256 endTimestamp)']);
for(const method of ['eth_call','eth_estimateGas']){
try{const result=await rpc(method,[tx,'latest']);console.log(method+' success: '+result);}
catch(e){let decoded;try{decoded=errors.parseError(e.data);}catch{}console.log(method+': '+(decoded?'NotActive (sale not open yet)':e.message)+'; selector '+(e.data?.slice(0,10)||'unavailable'));}
}
if(cfg.gasLimit==null)console.log('NOT LIVE READY: gasLimit unset. No signing or broadcast.');
else{
const fee=cfg.maxFeeGwei?parseUnits(String(cfg.maxFeeGwei),'gwei'):BigInt(price)*BigInt(cfg.gasPriceMultiplier ?? 2);
const cap=validateCost(BigInt(cfg.gasLimit),fee,BigInt(balance),cfg.maxGasBudgetEth);
const raw=await wallet.signTransaction({chainId:CHAIN,type:2,to:SEA,data,value:0n,nonce:Number(BigInt(pending)),gasLimit:BigInt(cfg.gasLimit),maxFeePerGas:fee,maxPriorityFeePerGas:0n});
if(!same(Transaction.from(raw).from,wallet.address))throw Error('Offline signature failed');
console.log('Offline signature verified. Maximum cost '+formatEther(cap)+' ETH. Not broadcast.');
}
}catch(e){const m=String(e.message);console.error(m.includes('privateKey')||m.length>160?'Preflight failed; details suppressed':m);process.exitCode=1;}
