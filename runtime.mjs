import {parseEther} from 'ethers';
export function runtimeOptions(cfg){
  const values={sendOffsetMs:0,sendTimeoutMs:1000,chainWaitTimeoutSeconds:60,receiptPollMs:150,
    reserveRetryBudget:true,allowPartialWallets:true,minReadyWallets:1,...cfg};
  for(const [key,lo,hi] of [['sendOffsetMs',-1000,1000],['sendTimeoutMs',200,3000],
    ['chainWaitTimeoutSeconds',10,600],['receiptPollMs',100,5000],['minReadyWallets',1,6]]){
    if(!Number.isInteger(values[key])||values[key]<lo||values[key]>hi)throw Error('Invalid '+key);
  }
  for(const key of ['reserveRetryBudget','allowPartialWallets'])
    if(typeof values[key]!=='boolean')throw Error('Invalid '+key);
  return values;
}
export function checkRetryReserve(plans,cfg){
  if(!cfg.reserveRetryBudget)return;
  for(const p of plans){
    if(p.cap*2n>parseEther(cfg.maxGasBudgetEth))throw Error('First attempt leaves no equal-cost retry budget: '+p.label);
    if(p.cap*2n>p.balance)throw Error('Balance cannot cover first attempt plus retry: '+p.label);
  }
  if(plans.reduce((n,p)=>n+p.cap*2n,0n)>parseEther(cfg.totalGasBudgetEth))
    throw Error('Combined budget cannot reserve one equal-cost retry per wallet');
}
export function pinStartTime(cfg,drop){
  const start=Number(drop.startTime);
  if(!Number.isSafeInteger(start)||start<=0)throw Error('Invalid on-chain start time');
  if(!cfg.autoStartTime&&start!==cfg.expectedStartTime)throw Error('Start time changed: review configuration');
  cfg.expectedStartTime=start;
  // Resolve auto mode ONCE. Subsequent checks/retries must not follow a changed sale.
  cfg.autoStartTime=false;
  return start*1000;
}
export function receiptMetrics(receipt){
  const value=key=>/^0x[0-9a-f]+$/i.test(receipt[key]??'')?String(BigInt(receipt[key])):null;
  return {blockNumber:value('blockNumber'),transactionIndex:value('transactionIndex'),
    gasUsed:value('gasUsed'),gasUsedForL1:value('gasUsedForL1'),effectiveGasPrice:value('effectiveGasPrice')};
}
