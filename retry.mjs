import {parseEther,parseUnits,toQuantity,keccak256,Transaction} from 'ethers';
import {CHAIN,NFT,SEA,abi,mintData,validateState,validateCost,same,sleep} from './core.mjs';

// Reserve maximum costs synchronously so parallel wallets cannot overspend.
export function retryBudget(initialCaps,totalBudget){
  let reserved=initialCaps.reduce((a,b)=>a+b,0n);
  const limit=parseEther(totalBudget);
  if(reserved>limit)throw Error('Initial plans exceed total budget');
  return cap=>{if(reserved+cap>limit)throw Error('Retry exceeds combined budget');reserved+=cap;};
}
export async function prepareRetry({plan,receipt,signer,read,cfg,reserve=()=>{},pause=sleep,now=Date.now}){
  if(plan.attempt!==0)throw Error('Only one retry allowed');
  if(!receipt||BigInt(receipt.status)!==0n||!same(receipt.transactionHash,plan.hash))throw Error('Retry requires original reverted receipt');
  if(!same(receipt.from,plan.address)||!same(receipt.to,SEA))throw Error('Receipt address mismatch');
  const original=await read('eth_getTransactionReceipt',[plan.hash]);
  if(!original||BigInt(original.status)!==0n||!same(original.blockHash,receipt.blockHash))throw Error('Reverted receipt changed');
  const canonical=await read('eth_getBlockByNumber',[receipt.blockNumber,false]);
  if(!canonical||!same(canonical.hash,receipt.blockHash))throw Error('Reverted block changed');
  const deadline=now()+10000;
  let block;
  while(true){
    block=await read('eth_getBlockByNumber',['latest',false]);
    if(!block?.number||!block.timestamp)throw Error('Missing retry block');
    const age=now()-Number(BigInt(block.timestamp))*1000;
    if(age>15000||age< -5000)throw Error('Stale retry block');
    if(BigInt(block.number)<BigInt(receipt.blockNumber))throw Error('Retry node behind receipt');
    if(BigInt(block.timestamp)>=BigInt(cfg.expectedStartTime))break;
    if(now()>=deadline)throw Error('Opening block not observed for retry');
    await pause(cfg.pollMs);
  }
  const call=async(to,name,args)=>abi.decodeFunctionResult(name,await read('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block.number]));
  const [chain,allowed,drop,fees,stats,latest,pending,balance,price]=await Promise.all([
    read('eth_chainId'),call(NFT,'getAllowedSeaDrop',[]),call(SEA,'getPublicDrop',[NFT]),call(SEA,'getAllowedFeeRecipients',[NFT]),call(NFT,'getMintStats',[plan.address]),
    read('eth_getTransactionCount',[plan.address,'latest']),read('eth_getTransactionCount',[plan.address,'pending']),read('eth_getBalance',[plan.address,'latest']),read('eth_gasPrice')]);
  const state={chain:BigInt(chain),now:BigInt(block.timestamp),allowed:allowed[0],drop:drop[0],fees:fees[0],userMinted:stats[0],minted:stats[1],maximum:stats[2]};
  validateState(state,cfg);
  if(state.now<state.drop.startTime)throw Error('Sale not open for retry');
  const nonce=BigInt(plan.tx.nonce)+1n;
  if(BigInt(latest)!==nonce||BigInt(pending)!==nonce)throw Error('Retry nonce changed or pending');
  if(nonce>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid retry nonce');
  const fee=cfg.maxFeeGwei?parseUnits(String(cfg.maxFeeGwei),'gwei'):BigInt(price)*BigInt(cfg.gasPriceMultiplier??2);
  if(fee<BigInt(price))throw Error('Retry fee below current gas price');
  const cap=validateCost(plan.tx.gasLimit,fee,BigInt(balance),cfg.maxGasBudgetEth);
  if(plan.cap+cap>parseEther(cfg.maxGasBudgetEth))throw Error('First attempt plus retry exceeds wallet budget');
  const data=mintData(state.fees[0]);
  if(data!==plan.tx.data)throw Error('Mint fee recipient changed');
  const tx={...plan.tx,nonce:Number(nonce),data,maxFeePerGas:fee};
  const result=await read('eth_call',[{from:plan.address,to:SEA,data,value:'0x0',gas:toQuantity(tx.gasLimit)},'latest']);
  if(result!=='0x')throw Error('Retry simulation failed');
  const raw=await signer.signTransaction(tx);
  if(!same(Transaction.from(raw).from,plan.address))throw Error('Retry signer mismatch');
  const [lastNonce,pendingNonce]=await Promise.all([read('eth_getTransactionCount',[plan.address,'latest']),read('eth_getTransactionCount',[plan.address,'pending'])]);
  if(BigInt(lastNonce)!==nonce||BigInt(pendingNonce)!==nonce)throw Error('Nonce changed during retry preparation');
  reserve(cap);
  return {...plan,tx,raw,hash:keccak256(raw),cap,attempt:1};
}