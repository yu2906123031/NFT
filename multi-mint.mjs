import {explorerEvidence} from './explorer.mjs';
import {HeadWatcher} from './head-watcher.mjs';
import {runtimeOptions,checkRetryReserve,pinStartTime,receiptMetrics} from './runtime.mjs';
import {acquireRunLock} from './run-lock.mjs';
import {assertNoPending,savePending,writeRunReport} from './journal.mjs';
import {createReadFallback} from './rpc-read.mjs';
import {prepareRetry,retryBudget} from './retry.mjs';
import {readFile} from 'node:fs/promises';
import {parseUnits,formatEther,toQuantity,keccak256,ZeroAddress,Transaction} from 'ethers';
import {loadLocalEnv} from './env.mjs';
import {CHAIN,NFT,SEA,abi,mintData,validateState,validateCost,same,sleep} from './core.mjs';
import {loadWallets,selectWallets,checkTotalBudget,waitUntil,dispatchGroups,fanout} from './multi-core.mjs';
import {RpcPool} from './rpc-pool.mjs';

const root=new URL('./',import.meta.url);
async function json(path){return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}
async function main(){
  const command=process.argv[2]??'check';
  if(!['check','prepare','bench','run'].includes(command))throw Error('Usage: node multi-mint.mjs check|prepare|bench|run [--live]');
  const live=command==='run'&&process.argv.includes('--live');
  await loadLocalEnv();
  const base=await json(process.env.MINT_CONFIG||new URL('config.json',root));
  const single=process.env.MINT_SINGLE==='1';
  const cfg=runtimeOptions(single?{...base,readRpcs:base.readRpcs??[base.readRpc],totalGasBudgetEth:base.maxGasBudgetEth,
    wallets:[{label:'wallet1',keyEnv:'MINT_PRIVATE_KEY',address:base.walletAddress||process.env.WALLET_ADDRESS,mode:base.trigger}]}:
    {...base,...await json(process.env.MULTI_CONFIG||new URL('multi-config.json',root))});
  const urls=[...new Set(cfg.broadcastRpcs)],readUrls=[...new Set(cfg.readRpcs||[cfg.readRpc])];
  if(!urls.length||urls.length>8||!readUrls.length||readUrls.length>3)throw Error('Use 1-8 broadcast and 1-3 read endpoints');
  for(const url of [...urls,...readUrls])if(new URL(url).protocol!=='https:')throw Error('HTTPS endpoints required');
  for(const [k,lo,hi]of [['rpcTimeoutMs',500,15000],['pollMs',100,5000],['prepareSeconds',30,180],['receiptTimeoutSeconds',10,600],['gasPriceMultiplier',1,10]]){
    if(!Number.isInteger(cfg[k])||cfg[k]<lo||cfg[k]>hi)throw Error('Invalid '+k);
  }
  if(!Number.isSafeInteger(cfg.expectedStartTime)||!Number.isSafeInteger(cfg.gasLimit)||cfg.gasLimit<21000)throw Error('Set expectedStartTime and verified gasLimit');
  const reads=new RpcPool({timeoutMs:cfg.rpcTimeoutMs,sockets:8});
  const writes=new RpcPool({timeoutMs:cfg.sendTimeoutMs,sockets:6,allowBroadcast:live});
  const activeReads=[];
  let releaseLock,watcher,journalOwned=false;
  const sentLabels=new Set();
  const runReport={startedAt:new Date().toISOString(),routes:urls.map((url,index)=>({index,host:new URL(url).hostname})),attempts:[],outcomes:[]};
  const unresolved=new Map();
  let journalQueue=Promise.resolve();
  const updateJournal=()=>{const snapshot=[...unresolved.values()];journalQueue=journalQueue.then(()=>savePending(snapshot));return journalQueue;};
  try{
    if(live){releaseLock=await acquireRunLock(new URL('multi-run.lock',root));await assertNoPending();}
    if(command==='bench'){
      console.log('Invalid-payload latency, NOT real inclusion latency. No valid transaction sent.');
      const result=await Promise.allSettled(urls.map(async(url,index)=>{
        const times=[];let failures=0;
        for(let i=0;i<12;i++){
          try{const ms=await writes.probe(url,cfg.rpcTimeoutMs);if(i)times.push(ms);}catch{failures++;}
          await sleep(250);
        }
        times.sort((a,b)=>a-b);
        return {endpoint:index,host:new URL(url).hostname,samples:times.length,failures,p50Ms:times[Math.floor(times.length*.5)]??null,p95Ms:times[Math.floor(times.length*.95)]??null};
      }));
      for(const r of result)console.log(r.status==='fulfilled'?r.value:{problem:'probe failed'});
      return;
    }
    const {loaded:wallets,issues}=loadWallets(cfg.wallets,process.env);
    for(const key of Object.keys(process.env))if(/^MINT_PRIVATE_KEY(?:_[1-6])?$/.test(key)||key==='PRIVATE_KEY')delete process.env[key];
    for(const issue of issues)console.log(issue);
    selectWallets({loaded:wallets,issues},cfg);
    if(!wallets.length)throw Error('No configured wallets');
    await Promise.allSettled(readUrls.map(async(url,i)=>{
      if(BigInt(await reads.call(url,'eth_chainId'))!==CHAIN)throw Error('Wrong read chain');
      activeReads.push(url);
      console.log('Read endpoint '+i+' chain verified');
    }));
    if(!activeReads.length)throw Error('No verified read endpoint');
    // Keep configured priority, not handshake completion order.
    activeReads.sort((a,b)=>readUrls.indexOf(a)-readUrls.indexOf(b));
    const read=createReadFallback(activeReads,reads.call.bind(reads));
    async function call(to,name,args,tag){
      return abi.decodeFunctionResult(name,await read('eth_call',[{to,data:abi.encodeFunctionData(name,args)},tag]));
    }
    async function snapshot(){
      const block=await read('eth_getBlockByNumber',['latest',false]);
      if(!block?.number||!block.timestamp)throw Error('Missing latest block');
      const age=Date.now()-Number(BigInt(block.timestamp))*1000;
      if(age>15000||age< -5000)throw Error('Clock/RPC freshness check failed; synchronize OS clock');
      const [allowed,drop,fees,stats,price]=await Promise.all([
        call(NFT,'getAllowedSeaDrop',[],block.number),call(SEA,'getPublicDrop',[NFT],block.number),
        call(SEA,'getAllowedFeeRecipients',[NFT],block.number),call(NFT,'getMintStats',[ZeroAddress],block.number),read('eth_gasPrice')
      ]);
      const s={chain:CHAIN,now:BigInt(block.timestamp),block:block.number,allowed:allowed[0],drop:drop[0],fees:fees[0],
        userMinted:stats[0],minted:stats[1],maximum:stats[2],price:BigInt(price)};
      console.log({startUTC:new Date(Number(s.drop.startTime)*1000).toISOString(),
        endUTC:new Date(Number(s.drop.endTime)*1000).toISOString(),remaining:String(s.maximum-s.minted),
        mintPriceWei:String(s.drop.mintPrice),chainTimeUTC:new Date(Number(s.now)*1000).toISOString()});
      validateState(s,cfg);
      return s;
    }
    function fingerprint(s){
      return JSON.stringify({drop:[...s.drop].map(String),fees:[...s.fees].map(a=>a.toLowerCase()),allowed:[...s.allowed].map(a=>a.toLowerCase())});
    }
    async function collect(s,simulate){
      const fee=cfg.maxFeeGwei?parseUnits(String(cfg.maxFeeGwei),'gwei'):s.price*BigInt(cfg.gasPriceMultiplier);
      if(fee<s.price)throw Error('Fee cap below current gas price');
      const data=mintData(s.fees[0]),gas=BigInt(cfg.gasLimit);
      const results=await Promise.allSettled(wallets.map(async w=>{
        const [stats,balance,latest,pending]=await Promise.all([
          call(NFT,'getMintStats',[w.address],s.block),read('eth_getBalance',[w.address,'latest']),
          read('eth_getTransactionCount',[w.address,'latest']),read('eth_getTransactionCount',[w.address,'pending'])
        ]);
        validateState({...s,userMinted:stats[0],minted:stats[1],maximum:stats[2]},cfg);
        if(BigInt(latest)!==BigInt(pending))throw Error('Pending transactions');
        const cap=validateCost(gas,fee,BigInt(balance),cfg.maxGasBudgetEth);
        if(simulate){
          // Future block timestamp is ONLY a read-only execution override.
          const result=await read('eth_call',[{from:w.address,to:SEA,data,value:'0x0',gas:toQuantity(gas)},s.block,{}, {time:toQuantity(s.drop.startTime+1n)}]);
          if(result!=='0x')throw Error('Unexpected simulation return');
        }
        if(BigInt(pending)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid nonce');
        const tx={type:2,chainId:CHAIN,to:SEA,data,value:0n,nonce:Number(BigInt(pending)),gasLimit:gas,maxFeePerGas:fee,maxPriorityFeePerGas:0n};
        return {label:w.label,mode:w.mode,address:w.address,signer:w.signer,cap,tx,balance:BigInt(balance)};
      }));
      const plans=[];let failed=false;
      results.forEach((r,i)=>{
        if(r.status==='fulfilled'){
          plans.push(r.value);
          console.log({label:r.value.label,mode:r.value.mode,address:r.value.address,balanceETH:formatEther(r.value.balance),nonce:r.value.tx.nonce,maxCostETH:formatEther(r.value.cap),simulation:simulate?'passed':'not repeated'});
        }else{failed=true;console.log({label:wallets[i].label,problem:r.reason.message});}
      });
      const total=checkTotalBudget(plans,cfg.totalGasBudgetEth);
      checkRetryReserve(plans,cfg);
      console.log('Combined maximum cost '+formatEther(total)+' ETH / budget '+cfg.totalGasBudgetEth+' ETH');
      return {plans,failed};
    }
    async function sign(plans){
      return Promise.all(plans.map(async p=>{
        const raw=await p.signer.signTransaction(p.tx);
        if(!same(Transaction.from(raw).from,p.address))throw Error('Signature recovery mismatch');
        const {signer,...publicPlan}=p;
        return {...publicPlan,raw,hash:keccak256(raw)};
      }));
    }
    let s=await snapshot();
    const start=pinStartTime(cfg,s.drop);
    runReport.startUTC=new Date(start).toISOString();
    runReport.configuredSendOffsetMs=cfg.sendOffsetMs;
    console.log({startUTC:new Date(start).toISOString(),remaining:String(s.maximum-s.minted),configuredWallets:wallets.length,missingWallets:issues.length,broadcastRoutes:urls.length});
    if(!live){
      const checked=await collect(s,true);
      if(command==='prepare'&&!checked.failed){
        const signed=await sign(checked.plans);
        for(const p of signed)console.log({label:p.label,offlineSignature:'verified',hash:p.hash});
      }
      console.log('READ ONLY / NO BROADCAST. '+(checked.failed?'NOT READY: resolve reported wallets.':'Checks passed for '+wallets.length+' configured wallets.'));
      if(checked.failed)process.exitCode=2;
      return;
    }
    if(Date.now()>=start-30000||s.now>=s.drop.startTime)throw Error('Start live mode at least 30 seconds before opening');
    const initial=await collect(s,true);
    if(initial.failed)throw Error('Wallet preflight failed; no broadcast');
    console.log('ARMED. Stop with Ctrl+C before broadcast. Keep wallet nonces unused.');
    await waitUntil(start-cfg.prepareSeconds*1000);
    s=await snapshot();
    const prepared=await collect(s,true);
    if(prepared.failed)throw Error('Preparation failed; no broadcast');
    const plans=await sign(prepared.plans);
    const preparedWrites=new Map();
    const prepareWrites=p=>preparedWrites.set(p.raw,new Map(urls.map(url=>[url,writes.prepareCall(url,'eth_sendRawTransaction',[p.raw])])));
    plans.forEach(prepareWrites);
    const sendPrepared=(url,method,[raw])=>{
      const send=preparedWrites.get(raw)?.get(url);
      if(method!=='eth_sendRawTransaction'||!send)throw Error('Broadcast bytes were not prepared');
      return send();
    };
    watcher=new HeadWatcher({urls:activeReads,rpc:reads.call.bind(reads),wsUrl:process.env.READ_WS_RPC||'',
      pollMs:cfg.pollMs,timeoutMs:Math.min(cfg.rpcTimeoutMs,1000)}).start();
    if(!process.env.READ_WS_RPC)console.log('No READ_WS_RPC configured; shared HTTP opening-block watcher enabled.');
    const warmConnections=async()=>{
      const result=await Promise.allSettled(urls.map(async(url,index)=>{
        const replies=await Promise.allSettled(Array.from({length:plans.length},()=>writes.probe(url,1000)));
        return {endpoint:index,connections:replies.filter(r=>r.status==='fulfilled').length};
      }));
      return result.filter(r=>r.status==='fulfilled').map(r=>r.value);
    };
    console.log({earlyWarmup:await warmConnections()});
    const reserveRetry=retryBudget(plans.map(p=>p.cap),cfg.totalGasBudgetEth);
    for(const p of [...initial.plans,...prepared.plans])p.signer=null;
    for(const p of plans)console.log({label:p.label,mode:p.mode,hash:p.hash,nonce:p.tx.nonce});
    await waitUntil(start-15000);
    const final=await snapshot();
    if(fingerprint(final)!==fingerprint(s))throw Error('Drop configuration changed');
    const last=await collect(final,false);
    if(last.failed)throw Error('Final wallet check failed');
    for(const p of plans){
      const current=last.plans.find(x=>x.label===p.label);
      if(current.tx.nonce!==p.tx.nonce||current.balance<p.cap*(cfg.reserveRetryBudget?2n:1n)||final.price>p.tx.maxFeePerGas)throw Error('Nonce/balance/fee changed: '+p.label);
    }
    if(Date.now()>=start-5000)throw Error('Final checks missed T-5s cutoff');
    // Persist only public hashes before entering the final warm/trigger phase.
    for(const p of plans)unresolved.set(p.label,p);
    await updateJournal();
    journalOwned=true;
    await waitUntil(start-10000);
    let warm=[];
    while(Date.now()<start-3000){
      warm=await warmConnections();
      await waitUntil(Math.min(start-3000,Date.now()+2000));
    }
    if(!warm.some(r=>r.connections>0))throw Error('No warmed broadcast endpoint');
    if(Date.now()>=start-2000)throw Error('Warm-up missed T-2s cutoff');
    const gates={
      clock:async()=>{
        await waitUntil(start+cfg.sendOffsetMs);
        if(Date.now()-(start+cfg.sendOffsetMs)>1000)throw Error('Clock trigger more than 1s late');
        if(Date.now()>Number(s.drop.endTime)*1000)throw Error('Sale ended');
      },
      chain:async()=>{
        const result=await watcher.waitForOpen(s.drop.startTime,s.drop.endTime,cfg.chainWaitTimeoutSeconds*1000);
        runReport.triggerSource=result.source;
        // Negative offsets are clock-only: chain mode never sends before an opening head.
        if(cfg.sendOffsetMs>0)await waitUntil(start+cfg.sendOffsetMs);
      }
    };
    async function observe(p){
      const deadline=Date.now()+cfg.receiptTimeoutSeconds*1000;
      while(Date.now()<deadline){
        let receipt;
        try{receipt=await read('eth_getTransactionReceipt',[p.hash]);}catch{await sleep(cfg.receiptPollMs);continue;}
        if(receipt){
          if(!same(receipt.from,p.address)||!same(receipt.to,SEA)){await sleep(cfg.receiptPollMs);continue;}
          if(BigInt(receipt.status)===0n)return {label:p.label,hash:p.hash,status:'REVERTED',...receiptMetrics(receipt),receipt};
          if(BigInt(receipt.status)!==1n)throw Error('Invalid receipt status');
          const logs=receipt.logs.filter(l=>same(l.address,NFT)).map(l=>{try{return abi.parseLog(l);}catch{return null;}});
          const mint=logs.find(l=>l?.name==='Transfer'&&same(l.args.from,ZeroAddress)&&same(l.args.to,p.address));
          return {label:p.label,hash:p.hash,status:mint?'MINT_INCLUDED_SOFT':'NO_EXPECTED_MINT_EVENT',tokenId:mint?String(mint.args.tokenId):null,...receiptMetrics(receipt)};
        }
        await sleep(cfg.receiptPollMs);
      }
      return {label:p.label,hash:p.hash,status:'UNKNOWN_CHECK_EXPLORER',explorer:'https://robinhoodchain.blockscout.com/tx/'+p.hash,explorerEvidence:await explorerEvidence(p)};
    }
    const pendingSubmissions=[];
    const outcomes=await dispatchGroups(plans,gates,async initialPlan=>{
      let p={...initialPlan,attempt:0};
      const wallet=wallets.find(w=>w.label===p.label);
      try{
        for(let attempt=0;attempt<2;attempt++){
          const attemptReport={label:p.label,attempt,mode:p.mode,hash:p.hash,sentAt:Date.now(),sendOffsetMs:Date.now()-start,submitted:false,routes:[]};
          sentLabels.add(p.label);
          const submission=fanout(p,urls,sendPrepared,(label,index,ok,ms,status)=>{
            attemptReport.routes.push({endpoint:index,accepted:ok,responseMs:ms,status});
            if(ok)attemptReport.submitted=true;
          });
          runReport.attempts.push(attemptReport);
          pendingSubmissions.push(submission);
          // Yield once so ALL wallets write their bytes before starting receipt I/O or logging.
          await new Promise(resolve=>setImmediate(resolve));
          const result=await observe(p);

          const {receipt,...summary}=result;
          attemptReport.observedAfterMs=Date.now()-attemptReport.sentAt;
          runReport.outcomes.push(summary);
          if(result.status!=='UNKNOWN_CHECK_EXPLORER')unresolved.delete(p.label);
          console.log(summary);
          if(result.status==='MINT_INCLUDED_SOFT')return summary;
          if(result.status!=='REVERTED'||attempt===1){process.exitCode=2;return summary;}
          try{
            p=await prepareRetry({plan:p,receipt,signer:wallet.signer,read,cfg,reserve:reserveRetry});
            prepareWrites(p);
            unresolved.set(p.label,p);
            await updateJournal();
            console.log({label:p.label,status:'RETRY_READY',hash:p.hash,nonce:p.tx.nonce});
          }catch(e){
            console.log({label:p.label,status:'RETRY_SKIPPED',reason:e.message});
            process.exitCode=2;return summary;
          }
        }
      }finally{wallet.signer=null;}
    });
    await Promise.allSettled(pendingSubmissions);
    for(const p of plans)if(!sentLabels.has(p.label))unresolved.delete(p.label);
    await updateJournal();
    outcomes.forEach((r,i)=>{
      if(r.status==='rejected'){console.log({group:['clock','chain'][i],status:'NOT_SENT',reason:r.reason.message});process.exitCode=2;}
      else for(const wallet of r.value)if(wallet.status==='rejected'){console.log('Wallet monitoring failed; verify previously printed hash');process.exitCode=2;}
    });
  }catch(e){
    const message=String(e.message??'Failure');
    runReport.error=message.length>180||/private|secret/i.test(message)?'Operation failed; sensitive details suppressed':message;
    throw e;
  }finally{
    watcher?.close();reads.close();writes.close();
    if(live&&releaseLock){
      runReport.finishedAt=new Date().toISOString();
      try{
        if(journalOwned){
          // A controlled pre-send failure must not leave a false UNKNOWN record.
          for(const [label] of unresolved)if(!sentLabels.has(label))unresolved.delete(label);
          await updateJournal();
        }
        runReport.unresolved=[...unresolved.values()].map(p=>({label:p.label,hash:p.hash}));
        console.log('Run report: '+decodeURIComponent((await writeRunReport(runReport)).pathname));
      }
      finally{await releaseLock();}
    }
  }
}
main().catch(e=>{
  // All expected errors are controlled. Do not serialize arbitrary signing errors.
  const message=String(e.message??'Failure');
  console.error(message.length>180||message.includes('privateKey')?'Operation failed; sensitive details suppressed':message);
  process.exitCode=1;
});
