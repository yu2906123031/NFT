import {SEA,same} from './core.mjs';
// Supplemental evidence only: explorer data NEVER authorizes a retry or clears UNKNOWN.
export async function explorerEvidence(plan,fetcher=fetch){
  if(!/^0x[0-9a-f]{64}$/i.test(plan.hash))return {status:'INVALID_HASH'};
  try{
    const response=await fetcher('https://robinhoodchain.blockscout.com/api/v2/transactions/'+plan.hash,
      {signal:AbortSignal.timeout(2000),redirect:'error'});
    if(response.status===404)return {status:'NOT_INDEXED'};
    if(!response.ok)return {status:'UNAVAILABLE'};
    const data=await response.json();
    if(typeof data.hash!=='string'||!same(data.hash,plan.hash)||
      typeof data.from?.hash!=='string'||!same(data.from.hash,plan.address)||
      typeof data.to?.hash!=='string'||!same(data.to.hash,SEA))return {status:'MISMATCH'};
    return {status:data.status==='ok'?'INDEXED_SUCCESS':data.status==='error'?'INDEXED_ERROR':'INDEXED_PENDING',
      blockNumber:Number.isSafeInteger(data.block_number)&&data.block_number>=0?data.block_number:null};
  }catch{return {status:'UNAVAILABLE'};}
}
