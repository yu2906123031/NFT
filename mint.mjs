import {prepareRetry} from './retry.mjs';
import { loadLocalEnv } from './env.mjs';
import { readFile } from 'node:fs/promises';
import { Wallet, ZeroAddress, formatEther, parseUnits, keccak256 } from 'ethers';
import { CHAIN, NFT, SEA, abi, sleep, same, mintData, validateState, validateCost, broadcast } from './core.mjs';

async function main() {
  await loadLocalEnv();
  const command = process.argv[2] ?? 'check';
  if (!['check','bench','run'].includes(command)) throw Error('Usage: node mint.mjs check|bench|run [--live]');
  const cfg = JSON.parse((await readFile(process.env.MINT_CONFIG || new URL('./config.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
  cfg.walletAddress ||= process.env.WALLET_ADDRESS;
  if (!Number.isInteger(cfg.gasPriceMultiplier ?? 2) || (cfg.gasPriceMultiplier ?? 2) < 1 || (cfg.gasPriceMultiplier ?? 2) > 10) throw Error('gasPriceMultiplier must be an integer from 1 to 10');
  const urls = [...new Set(cfg.broadcastRpcs)];
  if (!urls.length || urls.length > 8) throw Error('Configure 1 to 8 broadcast endpoints');
  for (const url of [cfg.readRpc,...urls]) if (new URL(url).protocol !== 'https:') throw Error('HTTPS RPC required');
  if (!['chain','clock'].includes(cfg.trigger)) throw Error('trigger must be chain or clock');
  for (const [key,lo,hi] of [['pollMs',100,5000],['prepareSeconds',30,120],['rpcTimeoutMs',500,15000],['receiptTimeoutSeconds',10,600]]) {
    if (!Number.isInteger(cfg[key]) || cfg[key]<lo || cfg[key]>hi) throw Error('Invalid '+key);
  }
  if (!Number.isSafeInteger(cfg.expectedStartTime) || cfg.expectedStartTime <= 0) throw Error('Invalid expectedStartTime');
  let id = 0;
  async function rpc(url,method,params=[],timeoutMs=cfg.rpcTimeoutMs) {
    // fetch pools persistent connections. Never log API paths or arbitrary server bodies.
    const response = await fetch(url, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),
      signal:AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw Error('RPC HTTP '+response.status);
    const data = await response.json();
    if (data.error) { const e=Error('RPC '+method+' error code '+Number(data.error.code)); e.rpcError=true; throw e; }
    if (!Object.hasOwn(data,'result')) throw Error('Missing RPC result');
    return data.result;
  }
  const read = (method,params) => rpc(cfg.readRpc,method,params);
  async function call(to,name,args,tag) {
    return abi.decodeFunctionResult(name,await read('eth_call',[{to,data:abi.encodeFunctionData(name,args)},tag]));
  }
  async function state(address) {
    const block=await read('eth_getBlockByNumber',['latest',false]);
    if (!block?.number || !block.timestamp) throw Error('Missing latest block');
    const v=await Promise.all([
      read('eth_chainId'),call(NFT,'getAllowedSeaDrop',[],block.number),
      call(SEA,'getPublicDrop',[NFT],block.number),call(SEA,'getAllowedFeeRecipients',[NFT],block.number),
      call(NFT,'getMintStats',[address],block.number)
    ]);
    const s={chain:BigInt(v[0]),now:BigInt(block.timestamp),allowed:v[1][0],drop:v[2][0],fees:v[3][0],
      userMinted:v[4][0],minted:v[4][1],maximum:v[4][2]};
    validateState(s,cfg);
    return s;
  }
  function show(s,address) {
    console.log(JSON.stringify({wallet:address,chainId:String(s.chain),nft:NFT,seaDrop:SEA,
      startUTC:new Date(Number(s.drop.startTime)*1000).toISOString(),
      endUTC:new Date(Number(s.drop.endTime)*1000).toISOString(),
      chainTimeUTC:new Date(Number(s.now)*1000).toISOString(),remaining:String(s.maximum-s.minted),
      walletMinted:String(s.userMinted),allowedFeeRecipients:[...s.fees],trigger:cfg.trigger},null,2));
  }
  async function probe(url,timeoutMs=cfg.rpcTimeoutMs) {
    const t=performance.now();
    try { await rpc(url,'eth_sendRawTransaction',['0x'],timeoutMs); }
    catch(e) { if(e.rpcError) return Math.round(performance.now()-t); throw e; }
    throw Error('Unexpected response to invalid-payload probe');
  }
  async function waitUntil(ms) {
    while(Date.now()<ms) await sleep(Math.min(1000,Math.max(1,ms-Date.now())));
  }
  if(command==='bench') {
    console.log('INVALID-PAYLOAD response latency only, not inclusion speed. No valid transaction sent.');
    const results=await Promise.allSettled(urls.map(async(url,index)=>{
      const times=[]; let failures=0;
      for(let i=0;i<12;i++) {
        try { const ms=await probe(url); if(i) times.push(ms); } catch { failures++; }
        await sleep(250);
      }
      times.sort((a,b)=>a-b);
      return {endpoint:index,host:new URL(url).hostname,samples:times.length,failures,
        p50Ms:times[Math.floor(times.length*.5)]??null,p95Ms:times[Math.floor(times.length*.95)]??null};
    }));
    for(const r of results) console.log(r.status==='fulfilled'?r.value:{error:'benchmark failed'});
    return;
  }
  if(command==='check' || !process.argv.includes('--live')) {
    console.log('READ ONLY. Wallet eligibility is only checked if walletAddress is configured.');
    if(cfg.gasLimit===null) console.log('NOT LIVE-READY: gasLimit is unset; pre-opening estimation may revert. See README.');
    show(await state(cfg.walletAddress||ZeroAddress),cfg.walletAddress||'not supplied');
    return;
  }
  let wallet;
  try { wallet=new Wallet(process.env.MINT_PRIVATE_KEY??''); }
  catch { throw Error('Set valid MINT_PRIVATE_KEY locally; do not paste it into chat'); }
  delete process.env.MINT_PRIVATE_KEY;
  const address=wallet.address;
  if(cfg.walletAddress && !same(cfg.walletAddress,address)) throw Error('Configured wallet does not match signer');
  let s=await state(address);
  show(s,address);
  const startMs=Number(s.drop.startTime)*1000;
  if(s.now>=s.drop.startTime || Date.now()>=startMs) throw Error('Scheduled run must start before sale; refusing late automatic mint');
  console.log('Waiting until T-'+cfg.prepareSeconds+'s. Do not use wallet for other transactions. Ctrl+C cancels before broadcast.');
  await waitUntil(startMs-cfg.prepareSeconds*1000);
  s=await state(address);
  if(Math.abs(Date.now()/1000-Number(s.now))>15) throw Error('Clock differs from chain by >15 seconds or RPC is stale');
  const feeRecipient=s.fees[0],data=mintData(feeRecipient);
  const [latest,pending,balanceHex,priceHex]=await Promise.all([
    read('eth_getTransactionCount',[address,'latest']),read('eth_getTransactionCount',[address,'pending']),
    read('eth_getBalance',[address,'latest']),read('eth_gasPrice')
  ]);
  if(BigInt(latest)!==BigInt(pending)) throw Error('Pending transactions exist');
  const fee=cfg.maxFeeGwei?parseUnits(String(cfg.maxFeeGwei),'gwei'):BigInt(priceHex)*BigInt(cfg.gasPriceMultiplier ?? 2);
  if(fee<BigInt(priceHex)) throw Error('Configured fee below current gas price');
  let gas;
  if(cfg.gasLimit!==null) {
    if(!/^[1-9][0-9]*$/.test(String(cfg.gasLimit))) throw Error('Invalid gasLimit');
    gas=BigInt(cfg.gasLimit);
    console.log('Manual gasLimit: execution has NOT been simulated before opening.');
  } else {
    try { gas=BigInt(await read('eth_estimateGas',[{from:address,to:SEA,data,value:'0x0'}]))*130n/100n; }
    catch { throw Error('Pre-opening estimate failed. Set gasLimit from verified simulation including L1 data gas; no guessed fallback.'); }
  }
  const cap=validateCost(gas,fee,BigInt(balanceHex),cfg.maxGasBudgetEth);
  let raw=await wallet.signTransaction({type:2,chainId:CHAIN,to:SEA,data,value:0n,nonce:Number(BigInt(pending)),
    gasLimit:gas,maxFeePerGas:fee,maxPriorityFeePerGas:0n});

  let hash=keccak256(raw);
  console.log('Prepared '+hash+'; maximum gas cost '+formatEther(cap)+' ETH; nonce '+BigInt(pending));
  await waitUntil(startMs-15000);
  const final=await state(address);
  if(final.drop.endTime!==s.drop.endTime || final.drop.maxTotalMintableByWallet!==s.drop.maxTotalMintableByWallet ||
    final.drop.feeBps!==s.drop.feeBps || final.drop.restrictFeeRecipients!==s.drop.restrictFeeRecipients ||
    !final.fees.some(a=>same(a,feeRecipient))) throw Error('Drop configuration changed');
  if(BigInt(await read('eth_getTransactionCount',[address,'pending']))!==BigInt(pending)) throw Error('Nonce changed');
  const warm=await Promise.allSettled(urls.map(url=>probe(url)));
  warm.forEach((r,i)=>console.log('Endpoint '+i+' warm-up: '+r.status));
  if(!warm.some(r=>r.status==='fulfilled')) throw Error('No reachable broadcast endpoint');
  if(Date.now()>=startMs) throw Error('Preparation missed start; refusing late broadcast');
  // Stop probes several seconds before trigger so they do not queue ahead of the mint.
  while(Date.now()<startMs-5000) {
    await sleep(Math.min(1000,startMs-5000-Date.now()));
    if(Date.now()<startMs-5000) await Promise.allSettled(urls.map(url=>probe(url)));
  }
  await waitUntil(startMs-2500);
  await Promise.allSettled(urls.map(url=>probe(url,Math.min(1000,cfg.rpcTimeoutMs))));
  if(Date.now()>=startMs) throw Error('Warm-up missed start');
  if(cfg.trigger==='clock') {
    console.log('CLOCK mode relies on OS time; early execution can revert.');
    await waitUntil(startMs);
  } else {
    await waitUntil(startMs-1000);
    while(true) {
      if(Date.now()>startMs+10000) throw Error('No opening block observed within 10 seconds');
      const block=await read('eth_getBlockByNumber',['latest',false]);
      if(BigInt(block.timestamp)>=s.drop.startTime) {
        if(BigInt(block.timestamp)>s.drop.endTime) throw Error('Sale ended');
        break;
      }
      await sleep(cfg.pollMs);
    }
  }
  let retryPlan={attempt:0,address,raw,hash,cap,tx:{type:2,chainId:CHAIN,to:SEA,data,value:0n,nonce:Number(BigInt(pending)),gasLimit:gas,maxFeePerGas:fee,maxPriorityFeePerGas:0n}};
  attempts: for(let attempt=0;attempt<2;attempt++){
  console.log('Broadcast attempt '+attempt+' '+new Date().toISOString()+' '+hash);
  const submissions=broadcast(urls,raw,hash,rpc,(i,ok,ms)=>console.log('Endpoint '+i+': '+(ok?'hash accepted':'error/timeout; checking receipt')+' '+ms+'ms'));
  const deadline=Date.now()+cfg.receiptTimeoutSeconds*1000;
  while(Date.now()<deadline) {
    let receipt;
    try { receipt=await read('eth_getTransactionReceipt',[hash]); } catch { await sleep(500); continue; }
    if(receipt) {
      await submissions;
      if(BigInt(receipt.status)===0n){
        if(attempt===1)throw Error('Retry reverted: '+hash+'. Retry limit reached.');
        console.log('First attempt reverted: '+hash+'; checking remaining supply for one retry.');
        retryPlan=await prepareRetry({plan:retryPlan,receipt,signer:wallet,read,cfg});
        raw=retryPlan.raw;hash=retryPlan.hash;
        continue attempts;
      }
      if(BigInt(receipt.status)!==1n)throw Error('Invalid receipt status');
      const minted=receipt.logs.filter(l=>same(l.address,NFT)).map(l=>{
        try{return abi.parseLog(l);}catch{return null;}
      }).filter(l=>l?.name==='Transfer' && same(l.args.from,ZeroAddress) && same(l.args.to,address));
      if(!minted.length) throw Error('No expected NFT mint event: '+hash);
      console.log('MINT INCLUDED (soft confirmation): token '+minted[0].args.tokenId+'; block '+BigInt(receipt.blockNumber)+'; '+hash);
      return;
    }
    await sleep(300);
  }
  await submissions;
  throw Error('Receipt unknown: '+hash+'. Check explorer before further action. No automatic retry.');
  }
}
main().catch(e=>{
  const m=String(e.message??'Unknown failure');
  console.error(m.includes('privateKey') || m.length>220?'Operation failed; detailed error suppressed':m);
  process.exitCode=1;
});
