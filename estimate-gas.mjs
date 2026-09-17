import{readFile,writeFile}from'node:fs/promises';
import{toQuantity,formatEther,parseUnits}from'ethers';
import{NFT,SEA,abi,mintData,validateCost}from'./core.mjs';
const cfg=JSON.parse((await readFile('config.json','utf8')).replace(/^\uFEFF/,''));
async function rpc(method,params){const r=await fetch(cfg.readRpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});const d=await r.json();if(d.error){throw Error(JSON.stringify(d.error));}return d.result;}
try{
const fees=abi.decodeFunctionResult('getAllowedFeeRecipients',await rpc('eth_call',[{to:SEA,data:abi.encodeFunctionData('getAllowedFeeRecipients',[NFT])},'latest']))[0];
const tx={from:cfg.walletAddress,to:SEA,data:mintData(fees[0]),value:'0x0'};
const time=toQuantity(BigInt(cfg.expectedStartTime)+1n);
for(const method of ['eth_call','eth_estimateGas']){
try{const result=await rpc(method,[tx,'latest',{}, {time}]);console.log(method+' future-time override: '+result);
if(method==='eth_estimateGas'){const estimate=BigInt(result);const gas=(estimate*150n+99n)/100n;console.log('estimate='+estimate+' proposedLimit='+gas);}}
catch(e){console.log(method+': '+e.message.slice(0,400));}
}
}catch(e){console.error('Simulation failed: '+e.message.slice(0,400));process.exitCode=1;}
