import { Wallet, parseEther } from 'ethers';
import { same, sleep, broadcast } from './core.mjs';
export function loadWallets(entries,env) {
  const loaded=[],issues=[],addresses=new Set(),labels=new Set();
  for(const entry of entries.filter(w=>w.enabled!==false)){
    if(!/^[a-zA-Z0-9_-]{1,32}$/.test(entry.label??'')||labels.has(entry.label))throw Error('Invalid/duplicate wallet label');
    labels.add(entry.label);
    if(!['clock','chain'].includes(entry.mode))throw Error('Invalid mode: '+entry.label);
    if(!/^MINT_PRIVATE_KEY(?:_[1-6])?$/.test(entry.keyEnv??''))throw Error('Invalid keyEnv: '+entry.label);
    const key=env[entry.keyEnv];
    if(!key){issues.push({label:entry.label,problem:'missing '+entry.keyEnv});continue;}
    let signer;
    try{signer=new Wallet(key);}catch{issues.push({label:entry.label,problem:'invalid private key format'});continue;}
    if(entry.address&&!same(entry.address,signer.address)){issues.push({label:entry.label,problem:'address mismatch'});continue;}
    if(addresses.has(signer.address.toLowerCase()))throw Error('Duplicate wallet: '+entry.label);
    addresses.add(signer.address.toLowerCase());
    loaded.push({...entry,address:signer.address,signer});
  }
  if(!labels.size||labels.size>6)throw Error('Enable between 1 and 6 wallets');
  return {loaded,issues};
}
export function checkTotalBudget(plans,budget){
  const sum=plans.reduce((s,p)=>s+p.cap,0n);
  if(sum>parseEther(budget))throw Error('Combined cost exceeds totalGasBudgetEth');
  return sum;
}
export async function waitUntil(target,now=Date.now,pause=sleep){
  while(now()<target)await pause(Math.max(1,Math.min(1000,target-now())));
}
export async function dispatchGroups(plans,gates,send){
  return Promise.allSettled(['clock','chain'].map(async mode=>{
    const group=plans.filter(p=>p.mode===mode);
    if(!group.length)return [];
    await gates[mode]();
    return Promise.allSettled(group.map(async plan=>send(plan)));
  }));
}
export const fanout=(plan,urls,rpc,report)=>broadcast(urls,plan.raw,plan.hash,rpc,(i,ok,ms)=>report(plan.label,i,ok,ms));
